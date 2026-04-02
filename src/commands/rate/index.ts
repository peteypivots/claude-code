import type { Command } from '../../commands.js'

const rate = {
  type: 'local-jsx',
  name: 'rate',
  description: 'Rate the last assistant response (thumbs up/down for training data)',
  argumentHint: '<up|down> [message]',
  isEnabled: () => true,
  load: () => import('./rate.js'),
} satisfies Command

export default rate
