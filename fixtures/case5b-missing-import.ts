// Imports from a module that does NOT exist on disk / in node_modules.
import { WidgetConfig } from "some-missing-package";

/**
 * Configures a widget (type imported from an unresolvable module).
 * @param config - The widget configuration
 */
export function configureWidget(config: WidgetConfig): void {
  void config;
}
