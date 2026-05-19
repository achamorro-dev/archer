const useColor = process.stderr.isTTY && !process.env.NO_COLOR

function color(code: string, value: string) {
  if (!useColor) return value
  return `\u001b[${code}m${value}\u001b[0m`
}

export const log = {
  info(message: string) {
    console.error(color("36", `-> ${message}`))
  },
  warn(message: string) {
    console.error(color("33", `! ${message}`))
  },
  section(message: string) {
    console.error("")
    console.error(color("32;1", message))
  },
}
