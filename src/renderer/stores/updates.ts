import { ref } from 'vue'
import { defineStore } from 'pinia'
import { initialUpdateState } from '@shared/update'
import { useUiStore } from './ui'

export const useUpdatesStore = defineStore('updates', () => {
  const state = ref({ ...initialUpdateState })

  async function check(): Promise<void> {
    useUiStore().modal = 'update'
    state.value = await window.api.update.check()
  }

  async function install(): Promise<void> {
    try {
      if (state.value.phase !== 'ready') state.value = await window.api.update.download()
      if (state.value.phase === 'ready' && useUiStore().modal === 'update') await window.api.update.install()
    } catch (error) {
      useUiStore().toast((error as Error).message || '无法安装更新', 'error')
    }
  }

  return { state, check, install }
})
