import { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import * as child_process from "node:child_process";
import * as util from "node:util";
import * as fsP from "node:fs/promises";
import { BuildOutput, BuildsDoc, Result, getLatestBuild, getLatestSuccessfulBuild, writeNewFile } from "./lp-shared.js";
import express from "express";
import cors from "cors";
import debugLib, { Debugger } from "debug";
import { OneAtATime } from "./OneAtATime.js";


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

        const dockerContainerName = `lpub-worker-${sourceHandle.documentId}`;
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

  const PORT = 8088;
  app.listen(PORT, () => {
    console.log(`lp-server listening at http://localhost:${PORT}`)
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
          } catch (e) {
            debug("error killing docker:", e);
          }
        })();
      }
    }
  }, attentionSpanMs);  // TODO: slow it down
}

main();
