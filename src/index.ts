import { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import cors from "cors";
import debugLib from "debug";
import express, { Request, Response } from "express";
import https from "node:https";
import fsP from "node:fs/promises";
import * as child_process from "node:child_process";
import * as util from "node:util";
import { OneAtATime } from "./OneAtATime.js";
import { BuildsDoc } from "./lp-shared.js";


const debug = debugLib("lp-server");
const exec = util.promisify(child_process.exec);

function prefixDebugger(debug: (...bits: any[]) => void, ...prefix: any[]): (...bits: any[]) => void {
  debug(...prefix);
  return (...bits: any[]) => debug(...prefix, ...bits);
}

const attentionSpanMs = 1000 * 60 * 5;  // 5 minutes

type WorkerInfo = {
  dockerContainerName: string,
  sourceUrl: string,
  buildsUrl: string,
  lastRequestTime: Date,
}

async function main() {
  // I've given up on Docker manifests for now
  const arch =
    process.arch === "arm64" ? "arm64" :
    process.arch === "x64" ? "amd64" : undefined;
  if (!arch) {
    console.error("unsupported arch", process.arch);
    process.exit(1);
  }

  try {
    const execResult = await exec('./obliterate-docker-workers.sh');
    execResult.stdout.length > 0 && debug(execResult.stdout);
    execResult.stderr.length > 0 && debug(execResult.stderr);
  } catch (e) {
    debug("error running obliterate-docker-workers.sh:", e);
  }

  const repo = new Repo({
    network: [
      new BrowserWebSocketClientAdapter("wss://sync.automerge.org"),
    ],
  });

  const workerInfos = new Map<string, WorkerInfo>();  // keyed by sourceUrl
  const startUpLocks = new OneAtATime<string, string>();
  let nextRequestNumber = 0;  // just for debugging

  const app = express()

  app.use(cors());

  app.get("/build/:sourceUrl", async (req, res) => {
    const requestNumber = nextRequestNumber++;
    const sourceUrl = req.params.sourceUrl;
    const subDebug = prefixDebugger(debug, `GET ${requestNumber} /build/${sourceUrl}`);

    const workerInfo = workerInfos.get(sourceUrl);

    if (workerInfo) {
      // TODO: check if the worker is still running?
      //   docker container inspect -f '{{.State.Status}}' <container_name> === "running"
      subDebug("worker exists");
      workerInfo.lastRequestTime = new Date();
      res.send(workerInfo.buildsUrl);
      return;
    }

    try {
      const buildsUrl = await startUpLocks.run(sourceUrl, async () => {
        subDebug("worker does not exist");

        const sourceHandle = repo.find(sourceUrl as AutomergeUrl);
        const buildsHandle = repo.create<BuildsDoc>();

        const dockerContainerName = `lp-worker-${sourceHandle.documentId}`;
        const buildsUrl = buildsHandle.url;

        subDebug("starting", dockerContainerName);
        const shCommand = `node lib/index.js ${sourceUrl} ${buildsUrl} > index.log 2>&1`;
        await exec(
          `docker run --name ${dockerContainerName} -d joshuahhh/lp-per-doc-server-${arch} sh -c "${shCommand}"`
        );
        subDebug("started", dockerContainerName);

        workerInfos.set(sourceUrl, {
          dockerContainerName,
          sourceUrl, buildsUrl,
          lastRequestTime: new Date(),
        });

        return buildsUrl;
      }, {
        onNotFirst: () => subDebug("request already running; waiting"),
      });
      res.send(buildsUrl);
    } catch (e) {
      subDebug("error starting docker:", e);
      throw e;
    }
  });

  async function handleStatusPage(req: Request, res: Response) {
    const workerInfosHtml =
      JSON.stringify(Array.from(workerInfos.values()), null, 2)
        .replaceAll(/automerge:.{28}/g, (match) =>
          `<a href="https://joshuahhh.com/amview/#/${match}">${match}</a>`
        );

    const dockerContainerResult = await exec("docker container list");

    const dockerImageResult = await exec("docker image list");

    const workerLogsHtmls = await Promise.all(
      Array.from(workerInfos.values()).map(async ({ dockerContainerName }) => {
        const logFileName = `${dockerContainerName}.log`;
        try {
          await exec(`docker cp ${dockerContainerName}:/app/index.log ${logFileName}`);
          const logContents = await fsP.readFile(logFileName, "utf8");
          return `
            <h3>${dockerContainerName}</h3>
            <pre>${logContents}</pre>
          `;
        } catch (e) {
          return `
            <h3>${dockerContainerName}</h3>
            <pre style="color: red">${e}</pre>
          `;
        } finally {
          try {
            await fsP.unlink(logFileName);
          } catch (e) {
            debug(`error unlinking ${logFileName}:`, e);
          }
        }
      })
    );

    res.contentType("text/html");
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>lp-server</title>
        </head>
        <body>
          <h1><pre>lp-server</pre></h1>
          <p>probably running ok! on commit ${(await exec('git rev-parse HEAD')).stdout.trim().slice(0, 7)}</p>
          <p><a href="/log">lp-server service log</a></p>
          <h2><pre>workerInfos</pre></h2>
          <div>  <!-- keep json chrome extension off our case -->
            <pre>${workerInfosHtml}</pre>
          </div>
          <h2><pre>docker container list</pre></h2>
          <pre>${dockerContainerResult.stdout}</pre>
          <h2><pre>docker image list</pre></h2>
          <pre>${dockerImageResult.stdout}</pre>
          <pre style="color: red">${dockerContainerResult.stderr}</pre>
          <h2><pre>worker logs</pre></h2>
          ${workerLogsHtmls.join("\n")}
        </body>
      </html>
    `);
  }

  app.get("/", async (req, res) => {
    await handleStatusPage(req, res);
  });

  app.get("/log", async (req, res) => {
    res.contentType("text/html");
    let response = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>lp-server service log</title>
        </head>
        <body>
          <h1><pre>lp-server service log</pre></h1>
          <p><a href="/">back</a></p>
    `;
    try {
      const journalctlResult = await exec("journalctl -u lp-server.service -b");

      res.contentType("text/html");
      response += `
        <pre>${journalctlResult.stdout}</pre>
        <pre style="color: red">${journalctlResult.stderr}</pre>
      `;
    } catch (e) {
      response += `
        <pre style="color: red">${e}</pre>
      `;
    }
    response += `
        </body>
      </html>
    `;
    res.send(response);
  });

  const PORT = 8088;
  if (process.env.NODE_ENV === "development") {
    app.listen(PORT, () => {
      console.log(`lp-server listening at http://localhost:${PORT}`)
    });
  } else {
    // TODO: make this all generic; make HTTP possible
    const privateKey = await fsP.readFile('/etc/letsencrypt/live/lp.joshuahhh.com/privkey.pem');
    const certificate = await fsP.readFile('/etc/letsencrypt/live/lp.joshuahhh.com/fullchain.pem');
    const PORT = 8088;
    https.createServer({
      key: privateKey,
      cert: certificate
    }, app).listen(PORT, () => {
      console.log(`lp-server listening somewhere or other, on port ${PORT}`)
    });
  }

  setInterval(() => {
    debug("checking for old workers");
    const now = new Date();
    for (const [sourceUrl, workerInfo] of workerInfos) {
      const { lastRequestTime, dockerContainerName } = workerInfo;
      if (now.getTime() - lastRequestTime.getTime() > attentionSpanMs) {
        debug("killing", dockerContainerName);
        workerInfos.delete(sourceUrl);
        (async () => {
          try {
            await exec(`docker kill ${dockerContainerName} && docker rm ${dockerContainerName}`);
            debug("killed", dockerContainerName);
          } catch (e) {
            debug("error killing/removing worker:", e);
          }
        })();
      }
    }
    debug("done checking for old workers");
  }, attentionSpanMs);  // TODO: slow it down
}

main();
