const fs = require("fs");
const path = require("path");
const {rollup} = require("rollup");
const {nodeResolve} = require("@rollup/plugin-node-resolve");
const {minify} = require("terser");

const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "src", "views", "assets");
const jsLimit = 400 * 1024;
const cssLimit = 300 * 1024;

async function buildUi() {
  fs.mkdirSync(outputDir, {recursive: true});

  const bundle = await rollup({
    input: path.join(projectRoot, "src", "browser", "ui.js"),
    plugins: [nodeResolve({browser: true})]
  });
  const generated = await bundle.generate({format: "iife", name: "BiovalidatorUi"});
  await bundle.close();

  const chunk = generated.output.find((item) => item.type === "chunk");
  const minified = await minify(chunk.code, {
    compress: true,
    mangle: true,
    format: {comments: false}
  });
  if (!minified.code) {
    throw new Error("The UI JavaScript bundle was empty.");
  }

  const bootstrapCss = fs.readFileSync(
      require.resolve("bootstrap/dist/css/bootstrap.min.css"),
      "utf8"
  );
  const applicationCss = fs.readFileSync(
      path.join(projectRoot, "src", "browser", "ui.css"),
      "utf8"
  );
  const css = `${bootstrapCss}\n${applicationCss}`;

  const jsBytes = Buffer.byteLength(minified.code);
  const cssBytes = Buffer.byteLength(css);
  if (jsBytes > jsLimit) {
    throw new Error(`UI JavaScript is ${jsBytes} bytes; limit is ${jsLimit}.`);
  }
  if (cssBytes > cssLimit) {
    throw new Error(`UI CSS is ${cssBytes} bytes; limit is ${cssLimit}.`);
  }

  fs.writeFileSync(path.join(outputDir, "ui.min.js"), minified.code);
  fs.writeFileSync(path.join(outputDir, "ui.min.css"), css);
  fs.copyFileSync(
      path.join(projectRoot, "media", "ega-logo.png"),
      path.join(outputDir, "ega-logo.png")
  );

  process.stdout.write(`Built browser UI (${jsBytes} bytes JS, ${cssBytes} bytes CSS).\n`);
}

buildUi().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
