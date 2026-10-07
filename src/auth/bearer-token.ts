type CloudflareSubtleCrypto = SubtleCrypto & {
  timingSafeEqual?: (
    first: ArrayBuffer | ArrayBufferView,
    second: ArrayBuffer | ArrayBufferView,
  ) => boolean;
};

const subtle = crypto.subtle as CloudflareSubtleCrypto;

/** Extract a single Bearer token from an Authorization header. */
export const bearerTokenFromAuthorization = (
  authorization: string | undefined,
) => {
  const [scheme, token, ...rest] = authorization?.split(" ") ?? [];
  return scheme === "Bearer" && token !== undefined && rest.length === 0
    ? token
    : undefined;
};

/** Compare two bearer tokens without disclosing where they differ. */
export const bearerTokensMatch = async (
  provided: string,
  expected: string,
) => {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(provided)),
    subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(providedHash, expectedHash);
  }

  // Node's Web Crypto implementation used by the lightweight test suite does
  // not expose Cloudflare's timingSafeEqual extension. Both inputs are fixed
  // size SHA-256 digests, so this fallback performs no early exit.
  const actual = new Uint8Array(providedHash);
  const wanted = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual[index]! ^ wanted[index]!;
  }
  return difference === 0;
};
