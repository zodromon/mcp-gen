import { WidgetConfig } from "@ext/types";

/**
 * Configure a widget from an externally-defined config type.
 * @param config - The widget configuration (imported through the path alias)
 */
export function configureWidget(config: WidgetConfig): boolean {
  return config.enabled && config.maxWidth > 0 && config.title.length > 0;
}
