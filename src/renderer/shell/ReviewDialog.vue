<script setup lang="ts">
/**
 * 变更审阅：文件级摘要、统一差异、表格预览与风险提示；用户确认后才会执行。
 */
import { computed } from 'vue'
import { useAgentStore } from '../stores/agent'
import { useUiStore } from '../stores/ui'
import Icon from '../components/Icon.vue'

const agent = useAgentStore()
const ui = useUiStore()

const review = computed(() => agent.proposal)
const hasErrors = computed(() =>
  Boolean(review.value?.changeSet.issues.some((issue) => issue.severity === 'error'))
)
const riskLabel = computed(() =>
  review.value?.changeSet.risk === 'high' ? '高风险：包含新建/删除或多文件修改' : '低风险：当前文档内容插入'
)

function close(): void {
  ui.reviewOpen = false
}

async function accept(): Promise<void> {
  await agent.acceptProposal()
}

async function reject(): Promise<void> {
  await agent.rejectProposal()
}
</script>

<template>
  <div v-if="ui.reviewOpen" class="modal-backdrop" @click.self="close">
    <section class="modal wide review" role="dialog" aria-modal="true" aria-label="审阅修改">
      <div class="modal-title">
        <div>
          <span class="eyebrow">REVIEW CHANGES</span>
          <h2>确认这次修改</h2>
          <p v-if="review">{{ review.changeSet.summary }}</p>
          <p v-else>正在校验提案…</p>
        </div>
        <button class="iconbtn" aria-label="关闭" @click="close"><Icon name="x" :size="15" /></button>
      </div>

      <div v-if="agent.proposalLoading" class="empty-state">
        <Icon name="loader" class="spin" :size="22" />
        <p>正在计算差异…</p>
      </div>

      <template v-else-if="review">
        <div class="review-meta">
          <span class="tag" :class="{ accent: review.changeSet.risk === 'low' }">{{ riskLabel }}</span>
          <span class="tag">{{ review.files.length }} 个文件</span>
          <span class="tag">事务 {{ review.changeSet.changeSetId.slice(-6) }}</span>
          <span v-if="review.autoApplicable" class="tag accent">可由策略自动应用</span>
        </div>

        <div v-if="review.changeSet.issues.length" class="issue-list">
          <div
            v-for="(issue, index) in review.changeSet.issues"
            :key="index"
            class="issue"
            :class="issue.severity"
          >
            <Icon :name="issue.severity === 'error' ? 'warning' : 'info'" :size="12" />
            <span>{{ issue.message }}</span>
          </div>
        </div>

        <div class="review-files">
          <article v-for="file in review.files" :key="file.key" class="review-file">
            <header>
              <div class="file-title">
                <Icon name="file" :size="14" />
                <b>{{ file.title }}</b>
                <small v-if="file.relativePath">{{ file.relativePath }}</small>
              </div>
              <div class="file-stats">
                <span>{{ file.summary }}</span>
                <span class="add">+{{ file.additions }}</span>
                <span class="del">-{{ file.deletions }}</span>
              </div>
            </header>

            <div v-if="file.tablePreview" class="table-preview">
              <table>
                <thead>
                  <tr>
                    <th v-for="(cell, index) in file.tablePreview.header" :key="index">
                      {{ cell.text || '—' }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rowIndex) in file.tablePreview.rows" :key="rowIndex">
                    <td
                      v-for="(cell, cellIndex) in row"
                      :key="cellIndex"
                      :class="{ uncertain: cell.status === 'uncertain' }"
                    >
                      {{ cell.text || (cell.status === 'uncertain' ? '待核对' : '—') }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p class="table-note">表格预览按 GFM 规则生成；标为「待核对」的单元格不会被自动填充。</p>
            </div>

            <div class="diff">
              <div v-for="(line, index) in file.diff" :key="index" class="diff-line" :class="line.type">
                <span class="no">{{ line.oldNo ?? '' }}</span>
                <span class="no">{{ line.newNo ?? '' }}</span>
                <span class="sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
                <span class="text">{{ line.text }}</span>
              </div>
              <p v-if="!file.diff.length" class="diff-empty">（无文本差异）</p>
            </div>

            <div v-if="file.issues.length" class="file-issues">
              <span v-for="(issue, index) in file.issues" :key="index" class="tag">{{ issue.message }}</span>
            </div>
          </article>
        </div>

        <div class="modal-footer">
          <span class="note"> 应用时会再次校验文档版本；如果文稿已被修改，旧提案会被拒绝。 </span>
          <div class="review-actions">
            <button class="ghostbtn" @click="reject">放弃</button>
            <button class="darkbtn" :disabled="hasErrors || !review.files.length" @click="accept">
              <Icon name="check" :size="12" />应用修改
            </button>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.review {
  display: flex;
  flex-direction: column;
}

.review-meta {
  display: flex;
  gap: 8px;
  margin: 18px 0 12px;
  flex-wrap: wrap;
}

.issue-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.issue {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 10px;
  line-height: 1.6;
  color: var(--soft);
  border: 1px solid var(--line);
  background: var(--side);
  border-radius: 6px;
  padding: 7px 9px;
}

.issue.error {
  border-color: #e2c3ba;
  background: #fbf1ef;
  color: #8d4436;
}

:root[data-theme='dark'] .issue.error {
  background: #33231f;
  border-color: #51362d;
  color: #dfb1a4;
}

.review-files {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  min-height: 0;
}

.review-file {
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
}

.review-file header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 14px;
  background: var(--side);
  border-bottom: 1px solid var(--line);
}

.file-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  min-width: 0;
}

.file-title b {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-title small {
  color: var(--muted);
  font-size: 9px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-stats {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 9px;
  color: var(--muted);
  flex-shrink: 0;
}

.file-stats .add {
  color: #4f7d5f;
}

.file-stats .del {
  color: #a05a45;
}

.table-preview {
  padding: 12px 14px 4px;
}

.table-preview table {
  border-collapse: collapse;
  width: 100%;
  font-size: 11px;
}

.table-preview th,
.table-preview td {
  border: 1px solid var(--line);
  padding: 7px 9px;
  text-align: left;
}

.table-preview th {
  background: var(--side);
  font-weight: 500;
  color: var(--soft);
}

.table-preview td.uncertain {
  color: #9a6a3f;
  background: color-mix(in srgb, #f2dcc2 30%, transparent);
}

.table-note {
  font-size: 9px;
  color: var(--muted);
  margin: 8px 0 0;
}

.diff {
  max-height: 280px;
  overflow: auto;
  padding: 8px 0;
  background: var(--page);
  font: 11px/1.65 var(--mono-font);
}

.diff-line {
  display: grid;
  grid-template-columns: 34px 34px 16px 1fr;
  gap: 4px;
  padding: 0 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.diff-line .no {
  color: var(--muted);
  text-align: right;
  font-size: 9px;
}

.diff-line.add {
  background: color-mix(in srgb, #cfe6d4 42%, transparent);
}

.diff-line.del {
  background: color-mix(in srgb, #f2d4cb 40%, transparent);
}

.diff-line .sign {
  color: var(--muted);
}

.diff-empty {
  font-size: 10px;
  color: var(--muted);
  padding: 6px 14px;
}

.file-issues {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 14px 12px;
}

.review-actions {
  display: flex;
  gap: 10px;
}

.review-actions .darkbtn {
  gap: 6px;
}
</style>
