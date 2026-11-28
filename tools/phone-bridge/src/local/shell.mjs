// Running operator-provided command templates.
//
// PHONE_TTS_CMD / PHONE_STT_CMD / PHONE_PLAY_CMD are argv templates, not shell
// lines:
//
//   C:\tools\whisper-cli.exe -m models\ggml-base.bin -l fa -nt -f "{wav}"
//
// They are split on whitespace with quote awareness and spawned directly. That
// avoids `cmd.exe` quote mangling (a path such as "C:\Program Files\..." breaks
// under `cmd /c`), avoids shell injection from transcribed text, and behaves
// the same on Windows and POSIX. A template that genuinely needs a pipeline can
// point at a small .cmd/.sh wrapper script.

import { runProcess } from "./adb.mjs";

/** Split a command template into argv, honouring "double" and 'single' quotes. */
export function splitCommand(template) {
  const text = String(template ?? "");
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && (text[i + 1] === '"' || text[i + 1] === "\\")) {
        // \" inside double quotes is an escaped quote on both platforms.
        current += text[i + 1];
        i += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

/**
 * Run a command template.
 *
 * @param {string} template
 * @param {{timeoutMs?:number, env?:object}} [options]
 */
export async function runTemplate(template, options = {}) {
  const argv = splitCommand(template);
  if (!argv.length) {
    return { ok: false, code: -1, stdout: "", stderr: "the command template is empty", spawnError: true };
  }
  return runProcess(argv[0], argv.slice(1), options);
}
