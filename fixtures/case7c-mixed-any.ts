// One file containing BOTH kinds of `any`: the classifier must treat them differently.
import { WidgetConfig } from "some-missing-package";

export function fromMissing(config: WidgetConfig): void {
  void config;
}

export function authorAny(data: any): void {
  void data;
}

export function authorUnknown(data: unknown): void {
  void data;
}
