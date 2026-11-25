/**
 * 弹窗层级：渲染端维护一个后进先出的弹窗栈。
 * 打开新弹窗压栈，关闭只退栈顶一层，所以从「关于」进入快捷键/更新等子弹窗后，
 * 关掉子弹窗会回到「关于」，而不是把整串弹窗一起关掉。
 */

/** 打开一层：已在栈顶时保持不变；已在下层时截断回该层，避免堆出重复层级。 */
export function pushModal<T extends string>(stack: readonly T[], next: T): T[] {
  if (stack[stack.length - 1] === next) return stack.slice()
  const index = stack.indexOf(next)
  return index >= 0 ? stack.slice(0, index + 1) : [...stack, next]
}

/** 关闭栈顶一层；空栈仍为空。 */
export function popModal<T extends string>(stack: readonly T[]): T[] {
  return stack.slice(0, -1)
}
