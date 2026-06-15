import { WidgetConfig } from "@ext/types";

/**
 * Same import shape as with-tsconfig/tools.ts. Here `@ext/types` is unresolvable
 * (no alias) so WidgetConfig collapses to `any` and this fail-louds — the
 * control proving discovery of the alias-bearing tsconfig is what fixed it.
 * @param config - The widget configuration
 */
export function configureWidget(config: WidgetConfig): boolean {
  return config.enabled && config.maxWidth > 0 && config.title.length > 0;
}
