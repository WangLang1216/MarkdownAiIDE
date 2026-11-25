/**
 * 品牌图标：主图标是白底 A，深色主题用深色版；两份 SVG 构图一致，只换配色。
 */

import iconDark from '../../../resources/icon-dark.png'
import iconWhite from '../../../resources/icon.png'

/** 按当前主题取图标：深色主题用深色底，浅色主题用白色底。 */
export function brandIcon(isDark: boolean): string {
  return isDark ? iconDark : iconWhite
}
