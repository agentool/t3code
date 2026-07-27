import { describe, expect, it } from "vite-plus/test";

import { hookSessionUpdate, makeAgyTurnState, type AgyTurnState } from "./agyEvents.ts";
import {
  AgyTranscriptCursor,
  dropPriorTurnRecords,
  MAX_TRANSCRIPT_LINE_CHARS,
  normalizeToolOutput,
  parseTranscriptLine,
  serializedTranscriptRecordSize,
  transcriptRecordUpdates,
} from "./agyTranscript.ts";

function stateWithActiveTool(stepIdx: number, name = "run_command"): AgyTurnState {
  const state = makeAgyTurnState();
  hookSessionUpdate(
    {
      event: "pre-tool-use",
      payload: { conversationId: "conversation-1", stepIdx, toolCall: { name, args: {} } },
    },
    state,
  );
  return state;
}

describe("parseTranscriptLine", () => {
  it("returns null for blank and half-written lines", () => {
    expect(parseTranscriptLine("")).toBeNull();
    expect(parseTranscriptLine('{"step_index": 1, "type": "RUN_COM')).toBeNull();
  });

  it("parses a complete record", () => {
    expect(parseTranscriptLine('{"step_index":2,"type":"PLANNER_RESPONSE"}')).toMatchObject({
      step_index: 2,
      type: "PLANNER_RESPONSE",
    });
  });

  it("sizes the complete parsed record rather than only string content", () => {
    const record = parseTranscriptLine(
      JSON.stringify({
        step_index: 2,
        type: "RUN_COMMAND",
        content: { summary: "small" },
        metadata: { payload: "x".repeat(4_096) },
      }),
    );

    expect(record).not.toBeNull();
    expect(serializedTranscriptRecordSize(record!)).toBeGreaterThan(4_096);
  });
});

describe("normalizeToolOutput", () => {
  it("strips the timestamp preamble", () => {
    const output = normalizeToolOutput(
      "Created At: 2026-07-24T17:31:41-04:00\nCompleted At: 2026-07-24T17:31:41-04:00\nresult",
    );
    expect(output).toBe("result");
  });

  it("dedents Antigravity's tab-indented framing without touching flush-left output", () => {
    // Antigravity indents its own framing with tabs but writes the tool's real
    // output flush left, so a plain common-prefix dedent would find zero.
    const output = normalizeToolOutput(
      "Created At: x\n\n\t\t\t\tThe command exited with code 0.\n\t\t\t\tOutput:\n\t\t\t\ttotal 16\ndrwxr-xr-x  4 alex staff",
    );
    expect(output).toBe(
      "The command exited with code 0.\nOutput:\ntotal 16\ndrwxr-xr-x  4 alex staff",
    );
  });

  it("dedents tab-indented source uniformly", () => {
    expect(normalizeToolOutput("\t\tconst a = 1;\n\t\t\tconst b = 2;")).toBe(
      "const a = 1;\n\tconst b = 2;",
    );
  });
});

describe("transcriptRecordUpdates", () => {
  it("streams assistant text as an agent message chunk", () => {
    const result = transcriptRecordUpdates(
      { step_index: 7, source: "MODEL", type: "PLANNER_RESPONSE", content: "All done." },
      makeAgyTurnState(),
    );

    expect(result.emittedAssistantText).toBe(true);
    expect(result.updates[0]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "All done." },
    });
  });

  it("skips empty planner responses", () => {
    const result = transcriptRecordUpdates(
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", content: "   " },
      makeAgyTurnState(),
    );

    expect(result.updates).toHaveLength(0);
    expect(result.emittedAssistantText).toBe(false);
  });

  it("ignores bookkeeping records that would read as assistant output", () => {
    for (const type of ["CHECKPOINT", "CONVERSATION_HISTORY", "USER_INPUT", "SYSTEM_MESSAGE"]) {
      const result = transcriptRecordUpdates(
        { step_index: 1, source: "SYSTEM", type, content: "internal" },
        makeAgyTurnState(),
      );
      expect(result.updates).toHaveLength(0);
    }
  });

  it("attaches tool output to the call the matching hook announced", () => {
    const state = stateWithActiveTool(3);
    const result = transcriptRecordUpdates(
      {
        step_index: 3,
        source: "MODEL",
        type: "RUN_COMMAND",
        content:
          "Created At: x\n\t\t\t\tThe command exited with code 0.\n\t\t\t\tOutput:\n\t\t\t\tok",
      },
      state,
    );

    expect(result.updates[0]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "agy-conversation-1-3",
      content: [
        {
          type: "content",
          content: { type: "text", text: "The command exited with code 0.\nOutput:\nok" },
        },
      ],
    });
  });

  it("still attaches output after the post hook completed the call", () => {
    // One drain pass reads hooks before the transcript, so for a fast tool the
    // PostToolUse hook and the record carrying its output arrive together. If
    // completing a call dropped its bookkeeping, that output would be lost.
    const state = stateWithActiveTool(3);
    hookSessionUpdate(
      { event: "post-tool-use", payload: { conversationId: "conversation-1", stepIdx: 3 } },
      state,
    );

    const result = transcriptRecordUpdates(
      { step_index: 3, source: "MODEL", type: "RUN_COMMAND", content: "Created At: x\nok" },
      state,
    );

    expect(result.updates[0]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "agy-conversation-1-3",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
  });

  it("records the steps whose output has been streamed", () => {
    // The transcript is read once by byte offset, so a step consumed before
    // its PostToolUse hook appears is never revisited; the bridge uses this to
    // complete the call immediately instead of waiting for a second record.
    const state = stateWithActiveTool(3);
    transcriptRecordUpdates(
      { step_index: 3, source: "MODEL", type: "RUN_COMMAND", content: "Created At: x\nok" },
      state,
    );

    expect(state.transcriptSeenSteps.has(3)).toBe(true);
  });

  it("holds tool output whose call has not been announced yet", () => {
    // The hook directory is listed before the transcript is read, so a tool
    // whose PreToolUse file lands in between arrives here first. Dropping it
    // would lose that output for good — the transcript is read once by offset.
    const state = makeAgyTurnState();
    const record = { step_index: 99, source: "MODEL", type: "RUN_COMMAND", content: "orphan" };

    const deferredResult = transcriptRecordUpdates(record, state);
    expect(deferredResult.updates).toHaveLength(0);
    expect(deferredResult.deferred).toBe(true);
    expect(state.transcriptSeenSteps.has(99)).toBe(false);

    // Once the hook arrives, replaying the held record attaches its output.
    hookSessionUpdate(
      {
        event: "pre-tool-use",
        payload: {
          conversationId: "conversation-1",
          stepIdx: 99,
          toolCall: { name: "run_command", args: {} },
        },
      },
      state,
    );
    const replayed = transcriptRecordUpdates(record, state);
    expect(replayed.deferred).toBeUndefined();
    expect(replayed.updates[0]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "agy-conversation-1-99",
    });
  });
});

describe("dropPriorTurnRecords", () => {
  const line = (step: number, type: string) => JSON.stringify({ step_index: step, type });

  it("keeps only what follows the last USER_INPUT", () => {
    // Shape taken from a real two-turn transcript: one append-only file per
    // conversation, each turn opening with USER_INPUT.
    const lines = [
      line(0, "USER_INPUT"),
      line(1, "CONVERSATION_HISTORY"),
      line(2, "PLANNER_RESPONSE"),
      line(3, "LIST_DIRECTORY"),
      line(4, "CHECKPOINT"),
      line(5, "PLANNER_RESPONSE"),
      line(6, "USER_INPUT"),
      line(7, "SYSTEM_MESSAGE"),
      line(8, "PLANNER_RESPONSE"),
    ];

    expect(dropPriorTurnRecords(lines)).toEqual([
      line(7, "SYSTEM_MESSAGE"),
      line(8, "PLANNER_RESPONSE"),
    ]);
  });

  it("drops this turn's own opening record on a fresh conversation", () => {
    expect(dropPriorTurnRecords([line(0, "USER_INPUT"), line(1, "PLANNER_RESPONSE")])).toEqual([
      line(1, "PLANNER_RESPONSE"),
    ]);
  });

  it("keeps everything when the opening record has not been written yet", () => {
    const lines = [line(2, "PLANNER_RESPONSE")];
    expect(dropPriorTurnRecords(lines)).toEqual(lines);
    expect(dropPriorTurnRecords([])).toEqual([]);
  });
});

describe("AgyTranscriptCursor", () => {
  it("holds back a partial trailing line until the rest arrives", () => {
    const cursor = new AgyTranscriptCursor();

    expect(cursor.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(cursor.push("2}\n")).toEqual(['{"b":2}']);
  });

  it("tracks the byte offset it has consumed", () => {
    const cursor = new AgyTranscriptCursor();
    cursor.push("abc\n");

    expect(cursor.bytesConsumed).toBe(4);
  });

  it("flushes the trailing line once the writer is finished", () => {
    const cursor = new AgyTranscriptCursor();
    cursor.push('{"a":1}\n{"b":2}');

    expect(cursor.flush()).toEqual(['{"b":2}']);
    expect(cursor.flush()).toEqual([]);
  });

  it("gives up on a record that never terminates, and resumes at the next one", () => {
    // Nothing else bounds a held-back line: the transcript is read in capped
    // chunks, so a record with no newline would be accumulated in full.
    const cursor = new AgyTranscriptCursor();
    const huge = "x".repeat(MAX_TRANSCRIPT_LINE_CHARS + 1);

    expect(cursor.push(huge)).toEqual([]);
    expect(cursor.carryLength).toBe(0);

    // The rest of the abandoned record is swallowed up to its newline; the
    // record after it is intact.
    expect(cursor.push('more-of-the-same\n{"a":1}\n')).toEqual(['{"a":1}']);
  });

  it("does not flush the tail of an abandoned record as if it were one", () => {
    const cursor = new AgyTranscriptCursor();
    cursor.push("y".repeat(MAX_TRANSCRIPT_LINE_CHARS + 1));

    expect(cursor.push("trailing-fragment")).toEqual([]);
    expect(cursor.flush()).toEqual([]);
  });

  it("keeps retained records out of the abandoned record's path", () => {
    // Retained lines used to be prepended to the carry, which put finished
    // records in the same buffer as a half-written one: the first retained line
    // was then consumed as the abandoned record's tail and the real fragment
    // emitted in its place.
    const cursor = new AgyTranscriptCursor();
    cursor.push("x".repeat(MAX_TRANSCRIPT_LINE_CHARS + 1));
    cursor.retain(['{"legit":1}']);

    expect(cursor.push('tail-of-abandoned\n{"next":2}\n')).toEqual(['{"legit":1}', '{"next":2}']);
  });

  it("still owes retained records at EOF", () => {
    const cursor = new AgyTranscriptCursor();
    cursor.retain(['{"held":1}']);

    expect(cursor.flush()).toEqual(['{"held":1}']);
    expect(cursor.flush()).toEqual([]);
  });

  it("counts retained records against the caller's budget", () => {
    const cursor = new AgyTranscriptCursor();
    cursor.retain(['{"a":1}', '{"b":2}']);

    expect(cursor.carryLength).toBe('{"a":1}'.length + 1 + '{"b":2}'.length + 1);
  });

  it("drops an aggregate retained suffix that exceeds its budget", () => {
    const cursor = new AgyTranscriptCursor();

    expect(cursor.retainWithinLimit(["1234", "5678"], 9)).toBe(false);
    expect(cursor.carryLength).toBe(0);
    expect(cursor.push('{"current":true}\n')).toEqual(['{"current":true}']);
  });

  it("preserves a bounded partial boundary when retained history overflows", () => {
    const cursor = new AgyTranscriptCursor();
    const boundary = '{"type":"USER_INPUT","content":"current turn"}';
    const cutoff = 17;
    cursor.push(boundary.slice(0, cutoff));

    expect(cursor.retainWithinLimit(["historical"], 20)).toBe(false);
    expect(cursor.carryLength).toBe(cutoff);
    expect(cursor.push(`${boundary.slice(cutoff)}\n{"current":true}\n`)).toEqual([
      boundary,
      '{"current":true}',
    ]);
  });

  it("keeps historical carry suppressible until a later boundary is observed", () => {
    const cursor = new AgyTranscriptCursor();
    const historical = '{"type":"PLANNER_RESPONSE","content":"old"}';
    const boundary = '{"type":"USER_INPUT","content":"current turn"}';
    const cutoff = 19;
    cursor.push(historical.slice(0, cutoff));

    expect(cursor.retainWithinLimit(["older history"], 24)).toBe(false);
    const completedHistory = cursor.push(`${historical.slice(cutoff)}\n`);
    // No boundary makes this eligible on its own; the bridge's overflow state
    // is what suppresses it rather than losing the carry needed for parsing.
    expect(dropPriorTurnRecords(completedHistory)).toEqual([historical]);

    expect(
      dropPriorTurnRecords(
        cursor.push(`${boundary}\n{"type":"PLANNER_RESPONSE","content":"new"}\n`),
      ),
    ).toEqual(['{"type":"PLANNER_RESPONSE","content":"new"}']);
  });

  it("keeps counting consumed bytes across an abandoned record", () => {
    // The offset is what the next read starts from, so dropping content must
    // not desynchronise it from the file.
    const cursor = new AgyTranscriptCursor();
    const huge = "z".repeat(MAX_TRANSCRIPT_LINE_CHARS + 1);
    cursor.push(huge);

    expect(cursor.bytesConsumed).toBe(Buffer.byteLength(huge, "utf8"));
  });

  it("discards complete retained history while preserving a partial line", () => {
    const cursor = new AgyTranscriptCursor();
    cursor.retain(['{"historical":true}']);
    cursor.push('{"type":"USER_INPUT"');

    expect(cursor.retainWithinLimit([], 1)).toBe(false);
    expect(cursor.push('}\n{"current":true}\n')).toEqual([
      '{"type":"USER_INPUT"}',
      '{"current":true}',
    ]);
  });
});
