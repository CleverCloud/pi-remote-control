// Transport test harness: runs the *real* extension against a mocked `pi`.
//
// Only the LLM "brain" is faked. The extension still connects to the relay,
// receives prompts over the pi WS, calls our mock `sendUserMessage`, and
// forwards the synthesized `message_update` deltas back through the relay.
//
//   PIDEV_RELAY_URL / PIDEV_SESSION select the relay + session (same as prod).
//
// Run after `npm run build`:
//   PIDEV_RELAY_URL=ws://localhost:8080 PIDEV_SESSION=demo node test/harness.mjs

import activate from "../dist/index.js";

const handlers = new Map();
let aborted = false;

const pi = {
  on(event, handler) {
    (handlers.get(event) ?? handlers.set(event, []).get(event)).push(handler);
  },
  registerCommand() {},
  // Interrupt the in-flight turn (drives the remote Stop / `abort` command).
  abort() {
    aborted = true;
    console.error("[harness] aborted: stopping the current turn");
  },
  // A turn: stream the canned reply token-by-token, then attempt a tool call
  // (which the extension gates on remote approval), then end the turn.
  async sendUserMessage(text, _opts) {
    console.error(`[harness] mock pi got prompt: ${JSON.stringify(text)}`);
    aborted = false;
    // A longer reply so a remote abort is observable mid-stream.
    await stream(`received: ${text} — streaming a longer reply so stop is observable: alpha bravo charlie delta echo foxtrot golf hotel india juliet`);
    if (aborted) { emit("agent_end", {}); return; }

    // Exercise the ask-user gate: ask the operator a question and use the answer.
    const ans = await emitTool("user_input_request", {
      prompt: "What should I name the output file?",
      choices: ["out.txt", "result.json"],
    });
    await stream(` [you chose: ${ans && ans.text ? ans.text : "(no answer)"}]`);

    // Exercise the approval gate: ask to run `bash`.
    const decision = await emitTool("tool_call", { toolName: "bash" });
    if (decision && decision.block) {
      await stream(` [bash blocked: ${decision.reason}]`);
    } else {
      emit("tool_execution_start", { toolName: "bash" });
      emit("tool_execution_end", { toolName: "bash" });
      await stream(` [bash ran]`);
    }
    emit("agent_end", {});
  },
};

function emit(event, payload) {
  for (const h of handlers.get(event) ?? []) h(payload);
}

// Await the first handler's (possibly async) return — used for tool_call,
// whose handler returns the block/allow decision.
async function emitTool(event, payload) {
  for (const h of handlers.get(event) ?? []) return await h(payload);
  return undefined;
}

function stream(reply) {
  return new Promise((resolve) => {
    const tokens = reply.split(/(\s+)/); // keep whitespace as its own token
    let i = 0;
    const tick = () => {
      if (aborted) { resolve(); return; } // stop streaming on a remote abort
      if (i < tokens.length) {
        emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: tokens[i++] } });
        setTimeout(tick, 30);
      } else {
        resolve();
      }
    };
    setTimeout(tick, 30);
  });
}

activate(pi, { mode: "rpc" });
console.error("[harness] extension activated; waiting for remote prompts…");
