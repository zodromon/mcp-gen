/**
 * Present on disk, but UNREACHABLE: without the `@ext/*` alias (see this dir's
 * tsconfig) the bare `@ext/types` specifier can't map to this file. Its presence
 * proves the control fails on the missing alias, not on a missing file.
 */
export interface WidgetConfig {
  title: string;
  maxWidth: number;
  enabled: boolean;
}
