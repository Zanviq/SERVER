/** 확장자 없는 상대 경로면 .ts / .tsx 를 차례로 붙여 본다. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (!specifier.startsWith(".") || /\.[a-z]+$/i.test(specifier)) throw err;
    for (const ext of [".ts", ".tsx"]) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(fileURLToPath(url))) {
        return { url: url.href, shortCircuit: true, format: "module-typescript" };
      }
    }
    throw err;
  }
}
