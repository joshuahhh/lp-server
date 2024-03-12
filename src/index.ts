import { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import cors from "cors";
import debugLib from "debug";
import express from "express";
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
        const shCommand = `node lib/index.js ${sourceUrl} ${buildsUrl} 2>&1 > index.log`;
        await exec(
          `docker run --name ${dockerContainerName} -d joshuahhh/lp-per-doc-server sh -c "${shCommand}"`
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

  app.get("/", async (req, res) => {
    const dockerResult = await exec("docker container list");

    const workerInfosHtml =
      JSON.stringify(Array.from(workerInfos.values()), null, 2)
        .replaceAll(/automerge:.{28}/g, (match) =>
          `<a href="https://joshuahhh.com/amview/#/${match}">${match}</a>`
        );

    res.contentType("text/html");
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>lp-server</title>
        </head>
        <body>
          <h1>lp-server</h1>
          probably running ok! on commit ${(await exec('git rev-parse HEAD')).stdout.trim().slice(0, 7)}
          <h2>workerInfos</h2>
          <div>  <!-- keep json chrome extension off our case -->
            <pre>${workerInfosHtml}</pre>
          </div>
          <h2>"docker container list"</h2>
          <pre>${dockerResult.stdout}</pre>
          <pre style="color: red">${dockerResult.stderr}</pre>
        </body>
      </html>
    `);
  });

  // TODO: make this all generic; make HTTP possible
  const privateKey = await fsP.readFile('/etc/letsencrypt/live/lp.joshuahhh.com/privkey.pem');
  const certificate = await fsP.readFile('/etc/letsencrypt/live/lp.joshuahhh.com/fullchain.pem');
  const PORT = 8088;
  https.createServer({
    key: privateKey,
    cert: certificate
  }, app).listen(PORT, () => {
    console.log(`lp-server listening at https://localhost:${PORT}`)
  });

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
