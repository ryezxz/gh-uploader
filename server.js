import express from "express";
import multer from "multer";
import { Octokit } from "@octokit/rest";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  // biar aman, batasi per file 100MB (sesuai request lu)
  limits: { fileSize: 100 * 1024 * 1024 }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/upload", upload.array("files"), async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const owner = String(req.body.owner || "").trim();
    const repo = String(req.body.repo || "").trim();
    const branch = String(req.body.branch || "main").trim();
    const basePathRaw = String(req.body.basePath || "").trim();
    const message = String(req.body.message || "Upload via web uploader").trim();

    // basePath rapihin (opsional)
    const basePath = basePathRaw
      ? basePathRaw.replace(/^\/+/, "").replace(/\/?$/, "/")
      : "";

    if (!token || !owner || !repo) {
      return res.status(400).send("Token/Owner/Repo wajib diisi.");
    }
    if (!req.files?.length) {
      return res.status(400).send("Pilih minimal 1 file.");
    }

    // Token dipakai sekali doang (tidak disimpan)
    const octokit = new Octokit({ auth: token });

    // Get latest commit SHA on branch
    const ref = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const latestCommitSha = ref.data.object.sha;

    // Get base tree SHA
    const commit = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: latestCommitSha,
    });
    const baseTreeSha = commit.data.tree.sha;

    // Build tree: create blob per file
    const tree = [];
    const skipped = [];

    for (const f of req.files) {
      const name = (f.originalname || "file").replace(/\\/g, "/");

      // safety: jangan upload hal sensitif
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
      return res
        .status(400)
        .send("Semua file ke-skip (misal .env/session/auth_info).");
    }

    // Create new tree
    const newTree = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree,
    });

    // Create commit
    const newCommit = await octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: newTree.data.sha,
      parents: [latestCommitSha],
    });

    // Update branch ref
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.data.sha,
    });

    let msg = `OK ✅ Commit: ${newCommit.data.sha}\nUploaded: ${tree.length} file`;
    if (skipped.length) msg += `\nSkipped (safety): ${skipped.join(", ")}`;
    res.type("text").send(msg);
  } catch (e) {
    // Multer fileSize limit
    if (e?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).send("Ada file > 100MB. Gagal upload.");
    }
    res.status(500).send(`Error: ${e?.message || e}`);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running on :${port}`));
