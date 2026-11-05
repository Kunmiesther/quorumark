// ApeX Omni private REST HMAC signing.
//
// Source of truth: ApeX-Protocol/apexomni-connector-node
//   src/omni/PrivateApi.ts :: PrivateApi.sign()
//   https://raw.githubusercontent.com/ApeX-Protocol/apexomni-connector-node/main/src/omni/PrivateApi.ts
//
// Algorithm:
//   messageString = String(timestampMs) + method.toUpperCase() + requestPath + params
//     - For GET/DELETE with query params, the SDK appends `?<qs>` to requestPath
//       and sets `params` in the signature to "".
//     - For POST/PUT, requestPath is the bare path and `params` is the qs body.
//   key = base64(secret)   // as a UTF-8 string, then used as raw HMAC key bytes
//   signature = base64( HMAC_SHA256(key, messageString) )
//
// Headers:
//   APEX-API-KEY       = <api key>
//   APEX-SIGNATURE     = <signature above>
//   APEX-TIMESTAMP     = <timestampMs as decimal string>
//   APEX-PASSPHRASE    = <passphrase>
//
// READ-ONLY use only in this project. No order/withdraw/transfer/leverage signing.

export interface ApexOmniSignInput {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Full request path INCLUDING the `?query` for GET/DELETE. */
  requestPath: string;
  /** Timestamp in milliseconds. */
  timestampMs: number;
  /** Body params (POST/PUT). Empty string for GET/DELETE (they inline the qs in requestPath). */
  params: string;
  /** Raw API secret as provided by ApeX. */
  secret: string;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Compute the base64 HMAC-SHA256 signature per the ApeX Omni SDK. */
export async function signApexOmni(input: ApexOmniSignInput): Promise<string> {
  const messageString =
    String(input.timestampMs) + input.method.toUpperCase() + input.requestPath + (input.params || "");
  const keyString = toB64(new TextEncoder().encode(input.secret));
  const keyBytes = new TextEncoder().encode(keyString);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(messageString),
  );
  return toB64(new Uint8Array(sigBuf));
}

export function apexOmniAuthHeaders(args: {
  apiKey: string;
  passphrase: string;
  timestampMs: number;
  signature: string;
}): Record<string, string> {
  return {
    "APEX-API-KEY": args.apiKey,
    "APEX-SIGNATURE": args.signature,
    "APEX-TIMESTAMP": String(args.timestampMs),
    "APEX-PASSPHRASE": args.passphrase,
  };
}
