/**
 * Checks for the MCP auth decision.
 *
 *   npm run auth:check
 *
 * Unlike the other three suites this needs no Neo4j and no container: the
 * decision is a pure function of the request and the environment, which is
 * most of the reason it was lifted out of the route. It runs in about a
 * second, so there is no excuse not to run it.
 *
 * Exits 1 on any failure.
 */
import assert from "node:assert/strict";

const PATH_SECRET = "path-secret-0123456789abcdef0123456789";
const TOKEN = "bearer-token-fedcba9876543210fedcba9876543210";

process.env.MCP_PATH_SECRET = PATH_SECRET;

const {
  authenticateMcp,
  constantTimeEquals,
  lastMcpAuthAttempt,
  mcpAuthMode,
  mcpAuthStatus,
  redactSecrets,
  resetMcpAuthAttempt,
} = await import("@/lib/mcp-auth");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err && err.message ? err.message : err}`);
  }
}
const section = (t) => console.log(`\n${t}`);

/** Set the mode by setting exactly what a deployment would set. */
function mode(which) {
  resetMcpAuthAttempt();
  delete process.env.MCP_BEARER_TOKEN;
  delete process.env.MCP_REQUIRE_TOKEN;
  if (which === "permissive") process.env.MCP_BEARER_TOKEN = TOKEN;
  if (which === "enforcing") {
    process.env.MCP_BEARER_TOKEN = TOKEN;
    process.env.MCP_REQUIRE_TOKEN = "1";
  }
  assert.equal(mcpAuthMode(), which, `mode() should have produced ${which}`);
}

const req = (headers = {}) => new Request("https://example.test/mcp/whatever", { headers });
const bearer = (t) => req({ authorization: `Bearer ${t}` });
const custom = (t) => req({ "x-brain-token": t });

const ok = (outcome, via) => {
  assert.equal(outcome.ok, true, `expected ok, got ${JSON.stringify(outcome)}`);
  if (via) assert.equal(outcome.via, via);
};
const denied = (outcome, reason) => {
  assert.equal(outcome.ok, false, `expected denial, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.reason, reason);
};

console.log("auth-check");

// ── Mode detection ───────────────────────────────────────────────────────────

section("Mode");

await check("no token configured is 'off'", () => {
  mode("off");
  assert.equal(mcpAuthStatus().tokenConfigured, false);
});

await check("a token alone is 'permissive'", () => {
  mode("permissive");
  assert.equal(mcpAuthStatus().tokenConfigured, true);
});

await check("MCP_REQUIRE_TOKEN is 'enforcing'", () => {
  mode("enforcing");
});

await check("MCP_REQUIRE_TOKEN accepts true/yes/on, ignores empty and 'false'", () => {
  for (const yes of ["1", "true", "TRUE", "yes", "on"]) {
    process.env.MCP_BEARER_TOKEN = TOKEN;
    process.env.MCP_REQUIRE_TOKEN = yes;
    assert.equal(mcpAuthMode(), "enforcing", `${yes} should enforce`);
  }
  for (const no of ["", "0", "false", "no"]) {
    process.env.MCP_BEARER_TOKEN = TOKEN;
    process.env.MCP_REQUIRE_TOKEN = no;
    assert.equal(mcpAuthMode(), "permissive", `${no} should not enforce`);
  }
});

await check("requiring a token with none configured enforces, and says so", () => {
  // Fail closed. Serving unauthenticated because a variable was forgotten is
  // the one outcome nobody would notice.
  delete process.env.MCP_BEARER_TOKEN;
  process.env.MCP_REQUIRE_TOKEN = "1";
  assert.equal(mcpAuthMode(), "enforcing");
  assert.equal(mcpAuthStatus().tokenConfigured, false);
  denied(authenticateMcp(bearer(TOKEN), PATH_SECRET), "bad-token");
});

// ── The path segment stays a factor in every mode ────────────────────────────

section("Path segment");

for (const which of ["off", "permissive", "enforcing"]) {
  await check(`a wrong path segment is refused in ${which} mode`, () => {
    mode(which);
    denied(authenticateMcp(bearer(TOKEN), "not-the-secret"), "bad-path");
  });

  await check(`a missing path segment is refused in ${which} mode`, () => {
    mode(which);
    denied(authenticateMcp(bearer(TOKEN), undefined), "bad-path");
  });

  await check(`an empty path segment is refused in ${which} mode`, () => {
    mode(which);
    denied(authenticateMcp(bearer(TOKEN), ""), "bad-path");
  });
}

await check("a correct token does not rescue a wrong path", () => {
  mode("enforcing");
  denied(authenticateMcp(bearer(TOKEN), `${PATH_SECRET}x`), "bad-path");
});

await check("a path secret that is a prefix of the real one is refused", () => {
  mode("off");
  denied(authenticateMcp(req(), PATH_SECRET.slice(0, -1)), "bad-path");
});

// ── off ──────────────────────────────────────────────────────────────────────

section("Mode: off (path only)");

await check("the correct path alone passes", () => {
  mode("off");
  ok(authenticateMcp(req(), PATH_SECRET), "path-only");
});

await check("a header is ignored rather than rejected", () => {
  mode("off");
  ok(authenticateMcp(bearer("anything-at-all"), PATH_SECRET), "path-only");
});

// ── permissive ───────────────────────────────────────────────────────────────

section("Mode: permissive");

await check("the correct token passes as 'token'", () => {
  mode("permissive");
  ok(authenticateMcp(bearer(TOKEN), PATH_SECRET), "token");
});

await check("no token still passes, recorded as a non-match", () => {
  mode("permissive");
  ok(authenticateMcp(req(), PATH_SECRET), "path-only");
  assert.equal(lastMcpAuthAttempt().tokenPresented, false);
  assert.equal(lastMcpAuthAttempt().tokenMatched, false);
});

await check("a WRONG token still passes, recorded as a non-match", () => {
  // Deliberate. This mode exists so the header can be proven to arrive
  // without any possibility of bricking the connector; a typo must show up
  // in the diagnostic, not as a 404.
  mode("permissive");
  ok(authenticateMcp(bearer("wrong-token"), PATH_SECRET), "path-only");
  assert.equal(lastMcpAuthAttempt().tokenPresented, true);
  assert.equal(lastMcpAuthAttempt().tokenMatched, false);
});

// ── enforcing ────────────────────────────────────────────────────────────────

section("Mode: enforcing");

await check("the correct token passes", () => {
  mode("enforcing");
  ok(authenticateMcp(bearer(TOKEN), PATH_SECRET), "token");
});

await check("a missing token is refused", () => {
  mode("enforcing");
  denied(authenticateMcp(req(), PATH_SECRET), "missing-token");
});

await check("a wrong token is refused", () => {
  mode("enforcing");
  denied(authenticateMcp(bearer("wrong-token"), PATH_SECRET), "bad-token");
});

await check("near-miss tokens are refused", () => {
  mode("enforcing");
  const nearMisses = [
    `${TOKEN}x`, // correct plus a suffix
    TOKEN.slice(0, -1), // a prefix
    `x${TOKEN.slice(1)}`, // one character differing, at the front
    `${TOKEN.slice(0, -1)}x`, // one character differing, at the end
    TOKEN.toUpperCase(), // case must matter
  ];
  for (const t of nearMisses) {
    denied(authenticateMcp(bearer(t), PATH_SECRET), "bad-token");
  }
});

// ── Header handling ──────────────────────────────────────────────────────────

section("Headers");

await check("X-Brain-Token works exactly like Authorization", () => {
  mode("enforcing");
  ok(authenticateMcp(custom(TOKEN), PATH_SECRET), "token");
  denied(authenticateMcp(custom("wrong"), PATH_SECRET), "bad-token");
});

await check("the Bearer scheme is case-insensitive", () => {
  mode("enforcing");
  for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
    ok(authenticateMcp(req({ authorization: `${scheme} ${TOKEN}` }), PATH_SECRET), "token");
  }
});

await check("surrounding whitespace in the header does not break the match", () => {
  mode("enforcing");
  ok(authenticateMcp(req({ authorization: `Bearer   ${TOKEN}` }), PATH_SECRET), "token");
  ok(authenticateMcp(req({ "x-brain-token": `  ${TOKEN}  ` }), PATH_SECRET), "token");
});

await check("a non-Bearer Authorization is treated as no token", () => {
  mode("enforcing");
  denied(authenticateMcp(req({ authorization: `Basic ${TOKEN}` }), PATH_SECRET), "missing-token");
  denied(authenticateMcp(req({ authorization: TOKEN }), PATH_SECRET), "missing-token");
});

await check("X-Brain-Token is used when Authorization carries another scheme", () => {
  // Belt and braces: if the platform injects its own Authorization, the
  // custom header is still a way through.
  mode("enforcing");
  ok(
    authenticateMcp(req({ authorization: "Basic abc123", "x-brain-token": TOKEN }), PATH_SECRET),
    "token",
  );
});

// ── The diagnostic ───────────────────────────────────────────────────────────

section("Diagnostic");

await check("it records which headers were seen", () => {
  mode("enforcing");
  authenticateMcp(bearer(TOKEN), PATH_SECRET);
  let a = lastMcpAuthAttempt();
  assert.equal(a.sawAuthorizationHeader, true);
  assert.equal(a.sawCustomHeader, false);
  assert.equal(a.tokenMatched, true);
  assert.equal(a.outcome, "ok (token)");

  authenticateMcp(custom(TOKEN), PATH_SECRET);
  a = lastMcpAuthAttempt();
  assert.equal(a.sawAuthorizationHeader, false);
  assert.equal(a.sawCustomHeader, true);
});

await check("it records a refusal and its reason", () => {
  mode("enforcing");
  authenticateMcp(req(), "wrong-path");
  const a = lastMcpAuthAttempt();
  assert.equal(a.pathOk, false);
  assert.equal(a.outcome, "bad-path");
  assert.equal(a.mode, "enforcing");
  assert.ok(Date.now() - Date.parse(a.at) < 5000, "the timestamp should be now");
});

await check("it NEVER contains the token or the path secret", () => {
  for (const which of ["off", "permissive", "enforcing"]) {
    for (const r of [req(), bearer(TOKEN), bearer("wrong"), custom(TOKEN)]) {
      for (const slug of [PATH_SECRET, "wrong-path", undefined]) {
        mode(which);
        authenticateMcp(r, slug);
        const dumped = JSON.stringify(lastMcpAuthAttempt());
        assert.ok(!dumped.includes(TOKEN), `token leaked in ${which}: ${dumped}`);
        assert.ok(!dumped.includes(PATH_SECRET), `path secret leaked in ${which}: ${dumped}`);
      }
    }
  }
});

await check("mcpAuthStatus is shaped for the health endpoint and leaks nothing", () => {
  mode("permissive");
  authenticateMcp(bearer(TOKEN), PATH_SECRET);
  const status = mcpAuthStatus();
  assert.equal(status.mode, "permissive");
  assert.equal(status.tokenConfigured, true);
  assert.ok(status.lastAttempt, "there should be a last attempt");
  const dumped = JSON.stringify(status);
  assert.ok(!dumped.includes(TOKEN));
  assert.ok(!dumped.includes(PATH_SECRET));
});

await check("it starts empty and resets", () => {
  mode("enforcing");
  assert.equal(lastMcpAuthAttempt(), null);
});

// ── Redaction ────────────────────────────────────────────────────────────────

section("Redaction");

await check("both secrets are stripped from error text", () => {
  mode("enforcing");
  const message =
    `Failed to POST https://brain.example/mcp/${PATH_SECRET} ` +
    `with Authorization: Bearer ${TOKEN}`;
  const out = redactSecrets(message);
  assert.ok(!out.includes(PATH_SECRET), "path secret survived redaction");
  assert.ok(!out.includes(TOKEN), "token survived redaction");
  assert.ok(out.includes("<redacted>"));
});

await check("redaction catches every occurrence, not just the first", () => {
  mode("enforcing");
  const out = redactSecrets(`${TOKEN} and again ${TOKEN} and ${PATH_SECRET}`);
  assert.ok(!out.includes(TOKEN));
  assert.ok(!out.includes(PATH_SECRET));
});

await check("redaction is a no-op when nothing is configured", () => {
  mode("off");
  delete process.env.MCP_PATH_SECRET;
  assert.equal(redactSecrets("nothing to hide"), "nothing to hide");
  process.env.MCP_PATH_SECRET = PATH_SECRET;
});

// ── The comparison itself ────────────────────────────────────────────────────

section("constantTimeEquals");

await check("it matches equal strings and nothing else", () => {
  assert.equal(constantTimeEquals("abc", "abc"), true);
  assert.equal(constantTimeEquals("abc", "abd"), false);
  assert.equal(constantTimeEquals("abc", "abcd"), false);
  assert.equal(constantTimeEquals("abc", "ab"), false);
  assert.equal(constantTimeEquals("abc", "ABC"), false);
});

await check("an absent or empty side never matches", () => {
  assert.equal(constantTimeEquals(undefined, "abc"), false);
  assert.equal(constantTimeEquals("abc", undefined), false);
  assert.equal(constantTimeEquals(undefined, undefined), false);
  assert.equal(constantTimeEquals("", ""), false);
});

await check("it compares unequal lengths without throwing", () => {
  // timingSafeEqual throws on a length mismatch, which is why both sides are
  // hashed first. A throw here would be a 500 instead of a 404.
  assert.equal(constantTimeEquals("a", "a".repeat(5000)), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
