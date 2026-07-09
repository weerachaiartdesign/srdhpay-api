// index.js - Main Router for Srdh Pay API

import { handleAuth } from './auth.js';
import { handleRegister } from './register.js';
import { handleSettings } from './settings.js';
import { handleUser } from './user.js';
import { handleReport } from './report.js';
import { handleAudit } from './audit.js';
import { handleSystem } from './system.js';
import { corsHeaders, jsonResponse, errorResponse } from './helper.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      // Auth routes
      if (path === '/api/auth/login' && method === 'POST') {
        return await handleAuth.login(request, env);
      }
      if (path === '/api/auth/guest' && method === 'POST') {
        return await handleAuth.guest(request, env);
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        return await handleAuth.logout(request, env);
      }
      if (path === '/api/auth/me' && method === 'GET') {
        return await handleAuth.me(request, env);
      }

      // Register routes
      if (path === '/api/register' && method === 'GET') {
        return await handleRegister.list(request, env);
      }
      if (path === '/api/register/import' && method === 'POST') {
        return await handleRegister.import(request, env);
      }
      if (path === '/api/register/receive' && method === 'POST') {
        return await handleRegister.receive(request, env);
      }
      if (path === '/api/register/assign-editor' && method === 'POST') {
        return await handleRegister.assignEditor(request, env);
      }
      if (path === '/api/register/edit' && method === 'POST') {
        return await handleRegister.edit(request, env);
      }
      if (path === '/api/register/return' && method === 'POST') {
        return await handleRegister.return(request, env);
      }
      if (path === '/api/register/pass' && method === 'POST') {
        return await handleRegister.pass(request, env);
      }
      if (path === '/api/register/propose' && method === 'POST') {
        return await handleRegister.propose(request, env);
      }
      if (path === '/api/register/approve' && method === 'POST') {
        return await handleRegister.approve(request, env);
      }
      if (path === '/api/register/pay' && method === 'POST') {
        return await handleRegister.pay(request, env);
      }
      if (path === '/api/register/cancel' && method === 'POST') {
        return await handleRegister.cancel(request, env);
      }
      if (path === '/api/register/recover' && method === 'POST') {
        return await handleRegister.recover(request, env);
      }
      if (path.match(/^\/api\/register\/[a-f0-9-]{36}$/) && method === 'PUT') {
        const uuid = path.split('/').pop();
        return await handleRegister.update(request, env, uuid);
      }

      // Settings routes (all under /api/settings)
      if (path.startsWith('/api/settings/')) {
        return await handleSettings.route(request, env);
      }

      // User routes
      if (path === '/api/users' && method === 'GET') {
        return await handleUser.list(request, env);
      }
      if (path === '/api/users' && method === 'POST') {
        return await handleUser.create(request, env);
      }
      if (path.match(/^\/api\/users\/\d+$/) && method === 'PUT') {
        const id = parseInt(path.split('/').pop());
        return await handleUser.update(request, env, id);
      }
      if (path.match(/^\/api\/users\/\d+$/) && method === 'DELETE') {
        const id = parseInt(path.split('/').pop());
        return await handleUser.delete(request, env, id);
      }
      if (path === '/api/users/reset-password' && method === 'POST') {
        return await handleUser.resetPassword(request, env);
      }

      // Report routes
      if (path === '/api/report/summary' && method === 'GET') {
        return await handleReport.summary(request, env);
      }
      if (path === '/api/report/status' && method === 'GET') {
        return await handleReport.status(request, env);
      }

      // Audit routes
      if (path === '/api/audit-logs' && method === 'GET') {
        return await handleAudit.list(request, env);
      }

      // System routes (permission, session, retention, telegram)
      if (path.startsWith('/api/system/')) {
        return await handleSystem.route(request, env);
      }

      // 404
      return jsonResponse({ success: false, error: 'Not found' }, 404);
    } catch (err) {
      console.error(err);
      return errorResponse('Internal server error', 500);
    }
  }
};