/** 渲染进程共享类型 */

export type EditorMode = 'live' | 'source' | 'split'

/** 即时渲染正文的宽度档位：默认居中、铺满可用宽度、较窄居中 */
export type ContentWidth = 'default' | 'full' | 'narrow'

/** 表示文件侧栏消费的带缩进层级的扁平文件节点。 */
export interface FlatFile {
  /** 用于界面或列表显示的名称。 */
  name: string
  /** 相对于工作区根目录的路径；文稿尚未关联该目录时可为空。 */
  relativePath: string
  /** 用于分派该记录的类别标记。 */
  kind: 'file' | 'directory'
  /** 文件的扩展名；目录可不提供。 */
  ext?: string
  /** 关联内容占用的大小，单位为字节。 */
  size?: number
  /** 节点在目录树展开后使用的缩进层级。 */
  depth: number
}
