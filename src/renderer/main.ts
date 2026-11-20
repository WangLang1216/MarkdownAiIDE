/**
 * 渲染进程入口：装配 Pinia、全局错误兜底与主题初始化。
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/markdown.css'

const app = createApp(App)
app.use(createPinia())

app.config.errorHandler = (error, _instance, info) => {
  console.error('[renderer] 未捕获错误', info, error)
  const message = error instanceof Error ? error.message : String(error)
  window.dispatchEvent(new CustomEvent('app:error', { detail: message }))
}

app.mount('#app')
