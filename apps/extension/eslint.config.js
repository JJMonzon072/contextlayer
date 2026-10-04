import { vueConfig } from '@contextlayer/config/eslint'

export default vueConfig({
  tsconfigRootDir: import.meta.dirname,
  environments: ['browser', 'webextensions'],
})
