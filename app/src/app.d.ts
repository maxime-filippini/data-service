// See https://svelte.dev/docs/kit/types#app.d.ts

declare global {
  namespace App {
    interface Locals {
      /** The signed-in Cloudflare Access user. */
      user: { email: string };
    }
    interface PageState {
      /** A message to show after navigating, e.g. "Deleted Core equity." */
      message?: string;
    }
  }
}

export {};
