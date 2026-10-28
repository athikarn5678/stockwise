// Scenario tests for finding R2-F8 (outage alarm across pause and resume).
//   node --test infra/learner-lab/operator/tests/outage-alarm-model.test.mjs
//
// This is a MODEL of documented CloudWatch alarm behaviour, not CloudWatch:
// - per-minute datapoints of the metric-math expression;
// - "M of N" evaluation with threshold < 1 and missing data breaching;
// - actions (SNS notifications) only on a state TRANSITION, and only while
//   actions are enabled; re-enabling actions does not notify by itself;
// - set-alarm-state forces a state without an action for INSUFFICIENT_DATA
//   (none is configured).
// The expression, threshold, periods and missing-data policy are read from
// terraform/monitoring.tf, so the model cannot silently drift from the
// configuration. Real CloudWatch behaviour stays an AWS validation item.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const monitoring = readFileSync(
  join(here, "../../terraform/monitoring.tf"),
  "utf8",
);
const alarm = monitoring.slice(
  monitoring.indexOf(
    'resource "aws_cloudwatch_metric_alarm" "no_healthy_target"',
  ),
);
const setting = (name) =>
  alarm.match(new RegExp(`\\n\\s*${name}\\s*=\\s*"?([^"\\n]+)"?`))[1].trim();

const EXPRESSION = "IF(FILL(desired, 1) >= 1, FILL(healthy, 0), 1)";
test("the model matches the deployed alarm configuration", () => {
  assert.ok(alarm.includes(`expression  = "${EXPRESSION}"`));
  assert.equal(setting("comparison_operator"), "LessThanThreshold");
  assert.equal(setting("threshold"), "1");
  assert.equal(setting("evaluation_periods"), "3");
  assert.equal(setting("datapoints_to_alarm"), "3");
  assert.equal(setting("treat_missing_data"), "breaching");
  assert.equal(setting("actions_enabled"), "var.app_desired_count > 0");
  assert.doesNotMatch(alarm, /insufficient_data_actions/);
});

// The expression for one minute: desired/healthy are numbers or null (missing).
function signal({ desired, healthy }) {
  const wanted = desired ?? 1;
  return wanted >= 1 ? (healthy ?? 0) : 1;
}

// minutes: [{ desired, healthy, actionsEnabled, reset }] in order. A "reset"
// is the operator's reconciliation at that minute (before evaluation).
function simulate(minutes, { reconcile }) {
  let state = "OK";
  const window = [];
  const notifications = [];
  for (const [index, minute] of minutes.entries()) {
    if (minute.reset && reconcile && state === "ALARM") {
      state = "INSUFFICIENT_DATA"; // set-alarm-state: no action configured for this state
      window.length = 0;
    }
    window.push(signal(minute) < 1); // breaching datapoint
    if (window.length > 3) window.shift();
    let next = state;
    if (window.length === 3 && window.every(Boolean)) next = "ALARM";
    else if (window.length > 0 && !window.at(-1)) next = "OK";
    if (next !== state) {
      if (minute.actionsEnabled && next !== "INSUFFICIENT_DATA")
        notifications.push(`${index}:${next}`);
      state = next;
    }
  }
  return { state, notifications };
}

const repeat = (count, minute) =>
  Array.from({ length: count }, () => ({ ...minute }));
const running = { desired: 1, actionsEnabled: true };

test("1. healthy application: no notification", () => {
  const { state, notifications } = simulate(
    repeat(10, { ...running, healthy: 1 }),
    { reconcile: true },
  );
  assert.equal(state, "OK");
  assert.deepEqual(notifications, []);
});

test("2. unhealthy registered target (healthy count 0): one ALARM notification", () => {
  const { state, notifications } = simulate(
    repeat(6, { ...running, healthy: 0 }),
    { reconcile: true },
  );
  assert.equal(state, "ALARM");
  assert.deepEqual(notifications, ["2:ALARM"]);
});

test("3. no registered target (metric reported as 0): ALARM", () => {
  const minutes = [
    ...repeat(3, { ...running, healthy: 1 }),
    ...repeat(4, { ...running, healthy: 0 }),
  ];
  assert.deepEqual(simulate(minutes, { reconcile: true }).notifications, [
    "5:ALARM",
  ]);
});

test("4. missing HealthyHostCount (the only task vanished): ALARM", () => {
  const minutes = [
    ...repeat(3, { ...running, healthy: 1 }),
    ...repeat(4, { ...running, healthy: null }),
  ];
  assert.deepEqual(simulate(minutes, { reconcile: true }).notifications, [
    "5:ALARM",
  ]);
});

test("5. intentional pause (desired 0, notifications disabled): no notification and no ALARM", () => {
  const minutes = [
    ...repeat(3, { ...running, healthy: 1 }),
    ...repeat(30, { desired: 0, healthy: null, actionsEnabled: false }),
  ];
  const { state, notifications } = simulate(minutes, { reconcile: true });
  assert.equal(state, "OK");
  assert.deepEqual(notifications, []);
});

test("6. resume succeeds: no notification", () => {
  const minutes = [
    ...repeat(10, { desired: 0, healthy: null, actionsEnabled: false }),
    { ...running, healthy: null, reset: true },
    ...repeat(10, { ...running, healthy: 1 }),
  ];
  const { state, notifications } = simulate(minutes, { reconcile: true });
  assert.equal(state, "OK");
  assert.deepEqual(notifications, []);
});

// The pause-time ALARM case: the desired metric was missing during the pause
// (counts as "should run"), so the alarm entered ALARM silently.
const silentAlarmThenFailedResume = [
  ...repeat(5, { desired: null, healthy: null, actionsEnabled: false }),
  { ...running, healthy: null, reset: true },
  ...repeat(5, { ...running, healthy: null }),
];

test("7a. REPRODUCTION: without reconciliation a failed resume never notifies", () => {
  const { state, notifications } = simulate(silentAlarmThenFailedResume, {
    reconcile: false,
  });
  assert.equal(state, "ALARM");
  assert.deepEqual(
    notifications,
    [],
    "re-enabling actions alone produced no notification",
  );
});

test("7b. resume fails while the alarm is already ALARM: the reconciliation notifies", () => {
  const { state, notifications } = simulate(silentAlarmThenFailedResume, {
    reconcile: true,
  });
  assert.equal(state, "ALARM");
  assert.deepEqual(notifications, ["7:ALARM"]);
});

test("8. repeated resume: one notification per failed attempt, never two for one attempt", () => {
  const minutes = [
    ...repeat(5, { desired: null, healthy: null, actionsEnabled: false }),
    { ...running, healthy: null, reset: true },
    { ...running, healthy: null, reset: true }, // second resume before re-evaluation: no-op
    ...repeat(4, { ...running, healthy: null }),
    { ...running, healthy: null, reset: true }, // a later, separate failed resume attempt
    ...repeat(4, { ...running, healthy: null }),
    ...repeat(4, { ...running, healthy: 1 }), // finally healthy
  ];
  const { state, notifications } = simulate(minutes, { reconcile: true });
  assert.equal(state, "OK");
  assert.deepEqual(notifications, ["7:ALARM", "13:ALARM", "16:OK"]);
});
