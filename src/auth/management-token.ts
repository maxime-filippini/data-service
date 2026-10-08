/** Operator credentials, independent from processor callbacks. */
export interface ManagementTokenBindings {
  readonly MANAGEMENT_API_TOKEN?: string;
}

export const managementToken = (bindings: ManagementTokenBindings) =>
  bindings.MANAGEMENT_API_TOKEN;
