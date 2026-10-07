/** Bindings required to authenticate a processor or control-plane caller. */
export interface ProcessingTokenBindings {
  readonly PROCESSING_API_TOKEN?: string;
}

export const processingToken = (bindings: ProcessingTokenBindings) =>
  bindings.PROCESSING_API_TOKEN;
