// Optional integration secrets are absent from Wrangler's generated types when
// they are not configured in the local .dev.vars file.
interface Env {
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
}
