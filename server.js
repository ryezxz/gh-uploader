import express from "express";
import multer from "multer";
import { Octokit } from "@octokit/rest";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB per file
    files: 300,                  // biar gak kebablasan
  },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function rid() {
  return crypto.randomBytes(6).toString("hex");
}

function log(rid, ...args) {
  console.log(`[${rid}]`, ...args);
}

// Basic request logger + request id
app.use((req, res, next) => {
  req.rid = rid();
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "-";
  log(req.rid, `${req.method} ${req.path}`, `ip=${ip}`);

  // detect abort (biasanya nyambung ke H27)
  req.on("aborted", () => log(req.rid, "⚠️ request aborted by client (browser/network)"));
  req.on("close", () => {
    // close bisa normal atau abort; statusCode 0 kadang
    if (!res.headersSent) log(req.rid, "⚠️ connection closed before response sent");
  });

  res.setHeader("x-request-id", req.rid);
  next();
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/health", (req, res) => res.json({ ok: true, rid: req.rid }));
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Helper: kirim error JSON yang jelas
function sendErr(res, status, rid, code, message, extra = {}) {
  return res.status(status).json({ ok: false, rid, code, message, ...extra });
}

app.post("/upload", (req, res) => {
  // Multer handler biar kita bisa tangkap errornya rapih
  upload.array("files")(req, res, async (err) => {
    const RID = req.rid;

    try {
      if (err) {
        // Multer errors
        if (err.code === "LIMIT_FILE_SIZE") {
          log(RID, "❌ multer LIMIT_FILE_SIZE");
          return sendErr(res, 413, RID, "LIMIT_FILE_SIZE", "Ada file > 100MB, ditolak.");
        }
        if (err.code === "LIMIT_FILE_COUNT") {
          log(RID, "❌ multer LIMIT_FILE_COUNT");
          return sendErr(res, 413, RID, "LIMIT_FILE_COUNT", "Jumlah file kebanyakan.");
        }
        log(RID, "❌ multer error:", err.message);
        return sendErr(res, 400, RID, "MULTER_ERROR", err.message);
      }

      const token = String(req.body.token || "").trim();
      const owner = String(req.body.owner || "").trim();
      const repo = String(req.body.repo || "").trim();
      const branch = String(req.body.branch || "main").trim();
      const basePathRaw = String(req.body.basePath || "").trim();
      const message = String(req.body.message || "Upload via web uploader").trim();

      const basePath = basePathRaw
        ? basePathRaw.replace(/^\/+/, "").replace(/\/?$/, "/")
        : "";

      if (!token || !owner || !repo) {
        log(RID, "❌ missing token/owner/repo");
        return sendErr(res, 400, RID, "MISSING_FIELDS", "Token/Owner/Repo wajib diisi.");
      }

      const files = req.files || [];
      if (!files.length) {
        log(RID, "❌ no files uploaded");
        return sendErr(res, 400, RID, "NO_FILES", "Pilih minimal 1 file.");
      }

      log(RID, `files=${files.length}`, `branch=${branch}`, `basePath=${basePath || "-"}`);

      const octokit = new Octokit({ auth: token });

      // 1) get latest commit
      const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
      const latestCommitSha = ref.data.object.sha;

      // 2) base tree
      const commit = await octokit.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
      const baseTreeSha = commit.data.tree.sha;

      // 3) blobs + tree
      const tree = [];
      const skipped = [];

      for (const f of files) {
        const name = (f.originalname || "file").replace(/\\/g, "/");

        // safety skip
        if (
          name === ".env" ||
          name.startsWith("session") ||
          name.startsWith("auth_info") ||
          name.includes("auth_info") ||
          name === "credentials.json"
        ) {
          skipped.push(name);
          continue;
        }

        // create blob
        const blob = await octokit.git.createBlob({
          owner,
          repo,
          content: f.buffer.toString("base64"),
          encoding: "base64",
        });

        tree.push({
          path: `${basePath}${name}`,
          mode: "100644",
          type: "blob",
          sha: blob.data.sha,
        });
      }

      if (!tree.length) {
        log(RID, "❌ all files skipped by safety filter");
        return sendErr(res, 400, RID, "ALL_SKIPPED", "Semua file ke-skip (misal .env/session/auth_info).", { skipped });
      }

      const newTree = await octokit.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree,
      });

      const newCommit = await octokit.git.createCommit({
        owner,
        repo,
        message,
        tree: newTree.data.sha,
        parents: [latestCommitSha],
      });

      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: newCommit.data.sha,
      });

      log(RID, "✅ done", `commit=${newCommit.data.sha}`, `uploaded=${tree.length}`, `skipped=${skipped.length}`);

      return res.json({
        ok: true,
        rid: RID,
        commit: newCommit.data.sha,
        uploaded: tree.length,
        skipped,
      });
    } catch (e) {
      // Octokit error detail
      const status = e?.status || 500;
      const msg = e?.message || String(e);
      const gh = e?.response?.data;

      log(RID, "❌ exception:", status, msg);
      if (gh) log(RID, "GitHub response:", JSON.stringify(gh).slice(0, 800));

      return sendErr(res, status >= 400 && status < 600 ? status : 500, RID, "UPLOAD_FAILED", msg, {
        github_status: e?.status,
        github_message: gh?.message,
      });
    }
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running on :${port}`));
