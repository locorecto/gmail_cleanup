import { OAuth2Client } from "google-auth-library";
import { shell } from "electron";
import * as http from "http";
import * as url from "url";
import * as keytar from "keytar";

const KEYTAR_SERVICE = "gmail-cleanup";
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

// Bundled Desktop OAuth client — acceptable for single-user personal use.
// See PLAN.md §3 for trust model discussion.
const CLIENT_ID = process.env.GMAIL_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET ?? "";

export function createOAuth2Client(redirectUri: string): OAuth2Client {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, redirectUri);
}

export async function runOAuthFlow(): Promise<{ email: string; client: OAuth2Client }> {
  // Pick a random port for the local callback listener
  const port = await getFreePort();
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const client = createOAuth2Client(redirectUri);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  // Start local listener before opening browser
  const code = await listenForCode(port);
  shell.openExternal(authUrl);

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token!,
    audience: CLIENT_ID,
  });
  const email = ticket.getPayload()!.email!;

  await keytar.setPassword(KEYTAR_SERVICE, email, JSON.stringify(tokens));
  return { email, client };
}

export async function loadSavedCredentials(email: string): Promise<OAuth2Client | null> {
  const raw = await keytar.getPassword(KEYTAR_SERVICE, email);
  if (!raw) return null;

  const tokens = JSON.parse(raw);
  // Use a placeholder redirect — it won't be called for token refresh
  const client = createOAuth2Client("http://127.0.0.1");
  client.setCredentials(tokens);

  // Persist refreshed tokens back to keychain automatically
  client.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await keytar.setPassword(KEYTAR_SERVICE, email, JSON.stringify(merged));
  });

  return client;
}

export async function revokeCredentials(email: string): Promise<void> {
  const raw = await keytar.getPassword(KEYTAR_SERVICE, email);
  if (raw) {
    try {
      const tokens = JSON.parse(raw);
      const client = createOAuth2Client("http://127.0.0.1");
      client.setCredentials(tokens);
      await client.revokeCredentials();
    } catch {
      // Best-effort revoke; always clear local storage
    }
    await keytar.deletePassword(KEYTAR_SERVICE, email);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Could not get free port"));
      }
    });
  });
}

function listenForCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      const parsed = url.parse(req.url ?? "", true);
      if (parsed.pathname === "/oauth/callback") {
        const code = parsed.query.code as string | undefined;
        const error = parsed.query.error as string | undefined;
        res.end(
          `<html><body><h2>${code ? "✓ Authenticated! You can close this tab." : `Error: ${error}`}</h2></body></html>`
        );
        server.close();
        if (code) resolve(code);
        else reject(new Error(error ?? "OAuth error"));
      }
    });
    server.listen(port, "127.0.0.1");
    server.on("error", reject);
    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth timeout"));
    }, 5 * 60 * 1000);
  });
}
