/**
 * An "external" type, reachable from tools.ts only via the `@ext/*` path alias
 * declared in this mini-project's tsconfig. With no tsconfig (or one lacking the
 * alias) the `@ext/types` specifier is unresolvable and collapses to `any` —
 * exactly the REPORT case 5b false-positive the project-discovery feature fixes.
 */
export interface WidgetConfig {
  title: string;
  maxWidth: number;
  enabled: boolean;
}
