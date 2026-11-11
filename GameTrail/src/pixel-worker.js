const {parentPort} = require("node:worker_threads");
const {jpegjs} = require("playwright-core/lib/utilsBundle");
const {candidates, match} = require("./pixel-button");
const {scan} = require("./visual-match");

parentPort.on("message", ({bytes, template, similarity, gameScale, locate}) => {
  try {
    const image = jpegjs.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    let result;
    if (template.side === 32) result = scan(image, template, similarity, gameScale);
    else if (locate) result = {point:match(image, template, similarity)};
    else {
      const hits = candidates(image, template, similarity, true);
      result = {hits, best:hits.slice().sort((a,b) => a.score-b.score)[0]};
    }
    parentPort.postMessage({result});
  } catch (error) {
    parentPort.postMessage({error:error.message});
  }
});
