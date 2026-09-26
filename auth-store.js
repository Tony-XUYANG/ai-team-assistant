const { randomUUID } = require("node:crypto");

function createAuthStore(pool) {
  return {
    async findAccount(username) {
      return (await pool.query("SELECT id,username,password_hash FROM public.accounts WHERE username=$1", [username])).rows[0];
    },
    async takeAuthAttempt(id, limit) {
      await pool.query("DELETE FROM public.auth_attempts WHERE started_at < NOW() - INTERVAL '15 minutes'");
      const row = (await pool.query(`INSERT INTO public.auth_attempts (id,attempts) VALUES ($1,1)
        ON CONFLICT (id) DO UPDATE SET attempts=auth_attempts.attempts+1 RETURNING attempts`, [id])).rows[0];
      return row.attempts <= limit;
    },
    async createSession(username, passwordHash, tokenHash) {
      await pool.query("DELETE FROM public.auth_sessions WHERE expires_at <= NOW()");
      return (await pool.query(`INSERT INTO public.auth_sessions (id,account_id,expires_at)
        SELECT $3,id,NOW()+INTERVAL '12 hours' FROM public.accounts WHERE username=$1 AND password_hash=$2
        RETURNING account_id AS id,expires_at`, [username, passwordHash, tokenHash])).rows[0];
    },
    async activateAccount(username, activationHash, passwordHash, tokenHash) {
      return (await pool.query(`WITH activated AS (
        UPDATE public.accounts SET password_hash=$3,activation_hash=NULL,activation_expires_at=NULL
        WHERE username=$1 AND activation_hash=$2 AND activation_expires_at>NOW() RETURNING id
      ) INSERT INTO public.auth_sessions (id,account_id,expires_at)
        SELECT $4,id,NOW()+INTERVAL '12 hours' FROM activated RETURNING account_id AS id,expires_at`,
      [username, activationHash, passwordHash, tokenHash])).rows[0];
    },
    async getSession(tokenHash) {
      return (await pool.query(`SELECT a.id,a.username,s.expires_at FROM public.auth_sessions s
        JOIN public.accounts a ON a.id=s.account_id WHERE s.id=$1 AND s.expires_at>NOW()`, [tokenHash])).rows[0];
    },
    async deleteSession(tokenHash) { await pool.query("DELETE FROM public.auth_sessions WHERE id=$1", [tokenHash]); },
  };
}

// Operator-only provisioning; deliberately not exposed as an HTTP route.
async function provisionAccount(client, { username, activationHash, claimLegacy = false, reset = false }) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query("SET LOCAL transaction_timeout='6000ms'");
    await client.query("LOCK TABLE public.accounts IN EXCLUSIVE MODE");
    if (claimLegacy && (reset || (await client.query("SELECT id FROM public.accounts LIMIT 1")).rowCount)) {
      throw Error("Legacy adoption is allowed only when provisioning the first account");
    }
    let account;
    if (reset) {
      account = (await client.query(`UPDATE public.accounts SET password_hash=NULL,activation_hash=$2,
        activation_expires_at=NOW()+INTERVAL '24 hours' WHERE username=$1 RETURNING id`, [username, activationHash])).rows[0];
      if (!account) throw Error("Account not found");
      await client.query("DELETE FROM public.auth_sessions WHERE account_id=$1", [account.id]);
    } else {
      account = (await client.query(`INSERT INTO public.accounts (id,username,activation_hash,activation_expires_at)
        VALUES ($1,$2,$3,NOW()+INTERVAL '24 hours') RETURNING id`, [randomUUID(), username, activationHash])).rows[0];
    }
    const adopted = claimLegacy ? (await client.query("UPDATE public.projects SET account_id=$1 WHERE account_id IS NULL", [account.id])).rowCount : 0;
    await client.query("COMMIT");
    return { id: account.id, adopted };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve provisioning failure. */ }
    throw error;
  }
}

module.exports = { createAuthStore, provisionAccount };
