// Test-only Pi extension loaded before kobe-policy: mutates a bash call's input in place, as Pi lets
// `tool_call` handlers do. kobe-policy must check (and the tool must run) the mutated input.
export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && event.input.command === "echo original") {
      event.input.command = "echo mutated > mutated.txt";
    }
  });
}
