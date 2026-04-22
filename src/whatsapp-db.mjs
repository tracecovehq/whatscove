import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const DEFAULT_DB_PATH = path.join(
  homedir(),
  "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite"
);

function quoteSql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildWhereClause(options) {
  const clauses = ["m.ZISFROMME = 0"];

  if (Number.isFinite(options.afterPk)) {
    clauses.push(`m.Z_PK > ${Math.trunc(options.afterPk)}`);
  }

  if (Number.isFinite(options.lookbackHours) && options.lookbackHours > 0) {
    clauses.push(
      `m.ZMESSAGEDATE >= ((strftime('%s','now') - 978307200) - ${Math.trunc(
        options.lookbackHours * 3600
      )})`
    );
  }

  if (options.chatFilter) {
    clauses.push(`lower(s.ZPARTNERNAME) LIKE ${quoteSql(`%${options.chatFilter.toLowerCase()}%`)}`);
  }

  return clauses.join("\n    AND ");
}

function buildMessageQuery(options) {
  const limit = Math.max(1, Math.trunc(options.limit ?? 250));
  const whereClause = buildWhereClause(options);

  return `
    SELECT
      m.Z_PK AS messagePk,
      datetime(m.ZMESSAGEDATE + 978307200, 'unixepoch') AS messageTimeUtc,
      datetime(m.ZMESSAGEDATE + 978307200, 'unixepoch', 'localtime') AS messageTimeLocal,
      s.ZPARTNERNAME AS chatName,
      s.ZCONTACTJID AS chatJid,
      m.ZFROMJID AS fromJid,
      COALESCE(
        NULLIF(gm.ZCONTACTNAME, ''),
        NULLIF(gm.ZFIRSTNAME, ''),
        NULLIF(pp.ZPUSHNAME, ''),
        NULLIF(m.ZPUSHNAME, ''),
        m.ZFROMJID
      ) AS senderName,
      m.ZMESSAGETYPE AS messageType,
      m.ZTEXT AS text,
      dataItems.previewTitle,
      dataItems.previewSummary,
      dataItems.previewContent1,
      dataItems.previewContent2
    FROM ZWAMESSAGE m
    JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
    LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
    LEFT JOIN ZWAPROFILEPUSHNAME pp ON pp.ZJID = m.ZFROMJID
    LEFT JOIN (
      SELECT
        ZMESSAGE,
        group_concat(coalesce(ZTITLE, ''), '\n') AS previewTitle,
        group_concat(coalesce(ZSUMMARY, ''), '\n') AS previewSummary,
        group_concat(coalesce(ZCONTENT1, ''), '\n') AS previewContent1,
        group_concat(coalesce(ZCONTENT2, ''), '\n') AS previewContent2
      FROM ZWAMESSAGEDATAITEM
      GROUP BY ZMESSAGE
    ) dataItems ON dataItems.ZMESSAGE = m.Z_PK
    WHERE ${whereClause}
    ORDER BY m.Z_PK DESC
    LIMIT ${limit};
  `;
}

export async function fetchRecentMessages(options = {}) {
  const databasePath = options.databasePath || process.env.WHATSAPP_CHAT_DB_PATH || DEFAULT_DB_PATH;
  const query = buildMessageQuery(options);
  const { stdout } = await execFileAsync("sqlite3", ["-json", databasePath, query], {
    maxBuffer: 1024 * 1024 * 16
  });

  return {
    databasePath,
    fetchedAt: new Date().toISOString(),
    messages: JSON.parse(stdout || "[]")
  };
}
