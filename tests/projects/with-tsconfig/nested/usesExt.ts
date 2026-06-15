import { WidgetConfig } from "@ext/types";

/**
 * Lives one directory below the tsconfig — discovery must WALK UP to find it,
 * and the `@ext/*` alias (baseUrl relative to the tsconfig dir) still resolves.
 * @param config - The widget configuration
 */
export function nestedTool(config: WidgetConfig): boolean {
  return config.enabled;
}
