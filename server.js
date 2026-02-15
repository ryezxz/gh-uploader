import express from "express";
import multer from "multer";
import { Octokit } from "@octokit/rest";
import crypto from "crypto";

const app = express();

// Serve UI dari folder public (anti white screen karena path error)
app.use(express.static("public", { extensions: ["html"] }));

// Upload config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB/file
    files: 400,                  // biar ga kebablasan
  },
});

const rid = () => crypto.randomBytes(6).toString("hex");
const log = (id, ...args) => console.log(`[${id}]`, ...args);

// Logger + request id + detect abort (H27)
app.use((req, res, next) => {
  req.rid = rid();
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "-";
  log(req.rid, `${req.method} ${req.path}`, `ip=${ip}`);

  req.on("aborted", () => log(req.rid, "⚠️ aborted by client (network/tab reload/closed)"));
  res.setHeader("x-request-id", req.rid);
  next();
});

app.get("/health", (req, res) => res.json({ ok: true, rid: req.rid }));

function sendErr(res, status, rid, code, message, extra = {}) {
  return res.status(status).json({ ok: false, rid, code, message, ...extra });
}

app.post("/upload", upload.array("files"), async (req, res) => {
  const RID = req.rid;

  try {
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
      return sendErr(res, 400, RID, "MISSING_FIELDS", "Token, Owner, dan Repo wajib diisi.");
    }

    const files = req.files || [];
    if (!files.length) {
      return sendErr(res, 400, RID, "NO_FILES", "Lu belum milih file apa pun.");
    }

    log(RID, `files=${files.length}`, `target=${owner}/${repo}@${branch}`, `basePath=${basePath || "-"}`);

    const octokit = new Octokit({ auth: token });

    // 1) latest commit
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

      // skip file sensitif
      if (
        name === ".env" ||
        name.startsWith("session") ||
        name.includes("auth_info") ||
        name === "credentials.json"
      ) {
        skipped.push(name);
        continue;
      }

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
      return sendErr(res, 400, RID, "ALL_SKIPPED", "Semua file ke-skip (karena dianggap sensitif).", { skipped });
    }

    const newTree = await octokit.git.createTree({
      owner, repo,
      base_tree: baseTreeSha,
      tree,
    });

    const newCommit = await octokit.git.createCommit({
      owner, repo,
      message,
      tree: newTree.data.sha,
      parents: [latestCommitSha],
    });

    await octokit.git.updateRef({
      owner, repo,
      ref: `heads/${branch}`,
      sha: newCommit.data.sha,
    });

    log(RID, "✅ success", `commit=${newCommit.data.sha}`, `uploaded=${tree.length}`, `skipped=${skipped.length}`);

    return res.json({
      ok: true,
      rid: RID,
      commit: newCommit.data.sha,
      uploaded: tree.length,
      skipped,
      note: "Kalau ada yang ke-skip, biasanya .env/session/auth_info. Itu emang sengaja biar aman."
    });
  } catch (e) {
    // Multer limit
    if (e?.code === "LIMIT_FILE_SIZE") {
      return sendErr(res, 413, RID, "LIMIT_FILE_SIZE", "Ada file lebih dari 100MB. Tolong kecilin dulu.");
    }

    const status = e?.status || 500;
    const ghMsg = e?.response?.data?.message;
    log(RID, "❌ error", status, e?.message || e, ghMsg ? `gh=${ghMsg}` : "");

    return sendErr(
      res,
      status >= 400 && status < 600 ? status : 500,
      RID,
      "UPLOAD_FAILED",
      e?.message || "Upload gagal (cek permission token / branch / repo).",
      { github_status: e?.status, github_message: ghMsg }
    );
  }
});

// Error handler terakhir (biar ga blank)
app.use((err, req, res, next) => {
  const RID = req?.rid || "no-rid";
  log(RID, "❌ unhandled", err?.message || err);
  res.status(500).json({ ok: false, rid: RID, code: "SERVER_CRASH", message: err?.message || String(err) });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running on http://localhost:${port}`));
