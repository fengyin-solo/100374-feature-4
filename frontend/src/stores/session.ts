import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
    // 流量监测逐段签认的操作身份：测量员锁定读数，审核员签认或退回。
    actor: '测量员·张澜',
    actors: ['测量员·张澜', '审核员·李核', '审核员·王审'],
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setActor(name: string) {
      this.actor = name
    },
  },
})
