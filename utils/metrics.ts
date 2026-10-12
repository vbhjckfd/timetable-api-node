/**
 * Custom metrics and handled-error reporting, backed by the New Relic agent.
 *
 * The agent is preloaded with `-r newrelic` (see package.json "start"); when
 * NEW_RELIC_LICENSE_KEY is unset it stays off and every call here is a no-op.
 *
 * New Relic custom metrics carry no dimensions, so attributes (stop, route,
 * tool) go onto the current transaction instead: query them with
 * `FROM Transaction SELECT count(*) FACET stop`. Metric names become
 * `Custom/<dotted name with slashes>`, e.g. `Custom/stop_timetable/request`.
 */
import newrelic from "newrelic";

type Attributes = Record<string, string | number | boolean>;

const metricName = (name: string): string => `Custom/${name.replaceAll(".", "/")}`;

export function count(name: string, value = 1, attributes?: Attributes): void {
  newrelic.incrementMetric(metricName(name), value);
  if (attributes) newrelic.addCustomAttributes(attributes);
}

export function distribution(name: string, value: number, attributes?: Attributes): void {
  newrelic.recordMetric(metricName(name), value);
  if (attributes) newrelic.addCustomAttributes(attributes);
}

export function captureException(error: unknown, attributes?: Attributes): void {
  newrelic.noticeError(error as Error, attributes);
}
