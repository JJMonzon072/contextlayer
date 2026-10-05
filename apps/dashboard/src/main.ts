import { createApp } from 'vue'

import App from './App.vue'
import { session } from './features/auth/session'
import { createAppRouter } from './router'
import './styles/main.css'

createApp(App).use(createAppRouter(session)).mount('#app')
