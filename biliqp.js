// ==UserScript==
// @name         Bilibili会员购购票抢票辅助
// @namespace    https://github.com/gemini-bilibili-show-helper
// @version      5.7
// @description  [商品详情页启动] 自动获取信息并抢票，成功跳转支付页后自动停止并提示。
// @author       Gemini
// @match        https://show.bilibili.com/platform/detail.html*
// @match        https://mall.bilibili.com/mall-dayu/neul-next/ticket/detail.html*
// @match        https://mall.bilibili.com/neul-next/ticket/detail.html*
// @match        https://mall.bilibili.com/neul-next/ticket/confirmOrder.html*
// @match        https://pay.bilibili.com/payplatform-h5/cashierdesk.html
// @grant        GM_addStyle
// @grant        GM_log
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      show.bilibili.com
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // --- 全局配置 ---
    const CONFIG = {
        submitButtonSelector: 'div.bili-button-type-primary',
        failureText: '当前页面已失效',
        linkRefreshTime: 3 * 60 * 1000, // 3分钟刷新一次链接
        paymentPagePattern: 'cashierdesk', // 支付页URL特征
        getSkuUrl: (projectId) => `https://show.bilibili.com/api/ticket/project/getV2?id=${projectId}&project_id=${projectId}&requestSource=neul-next`,
        getBuyerUrl: (projectId) => `https://show.bilibili.com/api/ticket/buyer/list?projectId=${projectId}`,
        prepareUrl: (projectId) => `https://show.bilibili.com/api/ticket/order/prepare?project_id=${projectId}`,
        finalOrderUrl: (projectId, token, ptoken, buyerId) => `https://mall.bilibili.com/neul-next/ticket/confirmOrder.html?token=${token}&project_id=${projectId}&ptoken=${ptoken}&buyerIds=${buyerId}&noTitleBar=1&from=itemshare`
    };

    const STATE = {
        countdownTimer: null,
        projectId: null,
        screenId: null,
        skuId: null,
        buyerId: null,
        skuData: null,
        buyerData: null,
    };

    // --- 页面路由 ---
    function handlePageRouting() {
        const currentUrl = window.location.href;
        if (currentUrl.includes(CONFIG.paymentPagePattern)) {
            runOnPaymentPage();
        } else if (currentUrl.includes('platform/detail.html') || currentUrl.includes('/mall-dayu/neul-next/ticket/detail.html') || currentUrl.includes('/neul-next/ticket/detail.html')) {
            runOnDetailPage();
        } else if (currentUrl.includes('ticket/confirmOrder.html')) {
            runOnConfirmPage();
        }
    }

    // --- 流程1: 商品详情页 ---
    async function runOnDetailPage() {
        const urlParams = new URLSearchParams(window.location.search);
        STATE.projectId = urlParams.get('id') || urlParams.get('project_id');
        createDetailControlPanel(); // 创建主面板

        // 绑定所有事件监听器
        document.getElementById('fetch-info-btn').addEventListener('click', fetchAllInfo);
        document.getElementById('start-grabbing-btn').addEventListener('click', startCountdown);
        document.getElementById('immediate-grab-btn').addEventListener('click', grabImmediately);
        document.getElementById('stop-grabbing-btn').addEventListener('click', () => stopGrabbing('用户手动停止'));

        // 新增：绑定打赏按钮和弹窗的事件
        const donateModal = document.getElementById('donate-modal');
        document.getElementById('donate-btn').addEventListener('click', () => {
            donateModal.style.display = 'flex';
        });
        document.querySelector('#donate-modal .modal-close').addEventListener('click', () => {
            donateModal.style.display = 'none';
        });
        donateModal.addEventListener('click', (e) => {
            if (e.target.id === 'donate-modal') {
                donateModal.style.display = 'none';
            }
        });
    }

    // --- 流程2: 订单确认页 ---
    async function runOnConfirmPage() {
        createConfirmStatusPanel();
        const isLooping = await GM_getValue('isLoopingActive', false);
        if (isLooping) {
            const startTime = await GM_getValue('loopStartTime', Date.now());
            if (Date.now() - startTime > CONFIG.linkRefreshTime) {
                updateStatus('链接可能已过期，正在自动续期...', '#f0ad4e');
                reExecuteApiFlow();
            } else {
                updateStatus('正在点击并准备刷新...', '#0275d8');
                const interval = await GM_getValue('clickInterval', 500);
                clickAndRefresh(interval);
            }
        } else {
            updateStatus('空闲，无抢票任务。', 'black');
        }
    }

    // --- 流程3: 支付成功页 ---
    async function runOnPaymentPage() {
        await GM_setValue('isLoopingActive', false);
        await GM_setValue('loopData', null);
        createSuccessPanel();
    }


    // --- 核心API逻辑 ---
    function fetchAllInfo() {
        document.getElementById('fetch-info-btn').disabled = true;
        updateStatus('正在获取场次和购票人信息...', '#0275d8');
        fetchSkuInfo();
        fetchBuyerInfo();
    }

    function fetchSkuInfo() {
        GM_xmlhttpRequest({
            method: "GET",
            url: CONFIG.getSkuUrl(STATE.projectId),
            responseType: 'json',
            onload: function(response) {
                const respData = response.response;
                if (respData?.data?.screen_list) {
                    STATE.skuData = respData.data;
                    updateStatus('场次信息获取成功!', '#5cb85c');
                    populateScreenSelector();
                } else {
                    updateStatus(`获取场次失败: ${respData?.message || '返回数据格式错误'}`, '#d9534f');
                }
            },
            onerror: function(error) { updateStatus('获取场次网络错误', '#d9534f'); }
        });
    }

    function fetchBuyerInfo() {
        GM_xmlhttpRequest({
            method: "GET",
            url: CONFIG.getBuyerUrl(STATE.projectId),
            responseType: 'json',
            onload: function(response) {
                const respData = response.response;
                if (respData?.data?.list) {
                    STATE.buyerData = respData.data.list;
                    updateStatus('购票人信息获取成功!', '#5cb85c');
                    populateBuyerSelector();
                } else {
                    updateStatus(`获取购票人失败: ${respData?.message || '请检查是否登录'}`, '#d9534f');
                }
            },
            onerror: function(error) { updateStatus('获取购票人网络错误', '#d9534f'); }
        });
    }

    function executeApiFlow() {
        updateStatus('正在请求接口...', '#0275d8');
        const { projectId, screenId, skuId } = STATE;
        const preparePayload = { project_id: projectId, screen_id: screenId, order_type: 1, count: 1, sku_id: skuId, newRisk: true, requestSource: "neul-next" };
        GM_xmlhttpRequest({
            method: "POST",
            url: CONFIG.prepareUrl(projectId),
            headers: { "Content-Type": "application/json;charset=UTF-8" },
            data: JSON.stringify(preparePayload),
            responseType: 'json',
            onload: function(response) {
                const respData = response.response;
                if (respData?.data?.token) {
                    const { token, ptoken } = respData.data;
                    updateStatus('Prepare成功! 正在跳转...', '#5cb85c');
                    navigateToConfirmPage(projectId, token, ptoken, STATE.buyerId);
                } else {
                    stopGrabbing(`Prepare失败: ${respData?.message || '未知错误'}`);
                    alert(`Prepare请求失败: ${respData?.message || '未知错误'}`);
                }
            },
            onerror: function(error) { stopGrabbing('Prepare请求网络错误'); }
        });
    }

    async function reExecuteApiFlow() {
        const loopData = await GM_getValue('loopData', null);
        if (!loopData) {
            updateStatus('无法自动续期：缺少抢票信息', '#d9534f');
            await GM_setValue('isLoopingActive', false);
            return;
        }

        const { projectId, screenId, skuId, buyerId } = loopData;
        const preparePayload = { project_id: projectId, screen_id: screenId, order_type: 1, count: 1, sku_id: skuId, newRisk: true, requestSource: "neul-next" };

        GM_xmlhttpRequest({
            method: "POST",
            url: CONFIG.prepareUrl(projectId),
            headers: { "Content-Type": "application/json;charset=UTF-8" },
            data: JSON.stringify(preparePayload),
            responseType: 'json',
            onload: async function(response) {
                const respData = response.response;
                if (respData?.data?.token) {
                    const { token, ptoken } = respData.data;
                    updateStatus('成功获取新链接，正在跳转...', '#5cb85c');
                    await GM_setValue('loopStartTime', Date.now());
                    const finalUrl = CONFIG.finalOrderUrl(projectId, token, ptoken, buyerId);
                    window.location.href = finalUrl;
                } else {
                    updateStatus(`链接续期失败: ${respData?.message || '未知错误'}`, '#d9534f');
                    await GM_setValue('isLoopingActive', false);
                }
            },
            onerror: async function(error) {
                 updateStatus('链接续期网络错误', '#d9534f');
                 await GM_setValue('isLoopingActive', false);
            }
        });
    }


    async function navigateToConfirmPage(projectId, token, ptoken, buyerId) {
        const clickInterval = document.getElementById('interval-input')?.value || 500;
        await GM_setValue('isLoopingActive', true);
        await GM_setValue('clickInterval', parseInt(clickInterval, 10));
        await GM_setValue('loopStartTime', Date.now());
        await GM_setValue('loopData', {
            projectId: STATE.projectId,
            screenId: STATE.screenId,
            skuId: STATE.skuId,
            buyerId: STATE.buyerId
        });

        const finalUrl = CONFIG.finalOrderUrl(projectId, token, ptoken, buyerId);
        window.location.href = finalUrl;
    }

    // --- 通用与新版逻辑 ---
    function waitForElement(selector, timeout = 3000) {
        return new Promise((resolve, reject) => {
            const intervalTime = 100;
            let elapsedTime = 0;
            const interval = setInterval(() => {
                const element = document.querySelector(selector);
                if (element) {
                    clearInterval(interval);
                    resolve(element);
                } else {
                    elapsedTime += intervalTime;
                    if (elapsedTime >= timeout) {
                        clearInterval(interval);
                        reject(new Error(`Element "${selector}" not found after ${timeout}ms`));
                    }
                }
            }, intervalTime);
        });
    }

    function grabImmediately() {
        if (!STATE.screenId || !STATE.skuId || !STATE.buyerId) {
            alert('请确保您已选择：场次、票种 和 购票人！');
            return;
        }
        document.getElementById('start-grabbing-btn').disabled = true;
        document.getElementById('immediate-grab-btn').disabled = true;
        document.getElementById('stop-grabbing-btn').disabled = false;
        executeApiFlow();
    }

    function startCountdown() {
        if (!STATE.screenId || !STATE.skuId || !STATE.buyerId) {
            alert('请确保您已选择：场次、票种 和 购票人！');
            return;
        }
        const startTimeStr = document.getElementById('start-time-input').value;
        if (!startTimeStr.match(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)) {
            alert('时间格式不正确！请使用 时:分:秒.毫秒 (例如 20:00:00.000)');
            return;
        }
        const [hours, minutes, secondsAndMs] = startTimeStr.split(':');
        const [seconds, milliseconds] = secondsAndMs.split('.');
        const now = new Date();
        const targetTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds, milliseconds);
        if (targetTime <= now) {
            alert('设定的时间已过！请设置一个未来的时间。');
            return;
        }
        document.getElementById('start-grabbing-btn').disabled = true;
        document.getElementById('immediate-grab-btn').disabled = true;
        document.getElementById('stop-grabbing-btn').disabled = false;
        function updateCountdownDisplay() {
            if (STATE.countdownTimer === null) return;
            const timeLeft = targetTime - new Date();
            if (timeLeft <= 0) {
                document.getElementById('countdown-display').textContent = '00:00:00.000';
                executeApiFlow();
                return;
            }
            const h = String(Math.floor(timeLeft / 3600000)).padStart(2, '0');
            const m = String(Math.floor((timeLeft % 3600000) / 60000)).padStart(2, '0');
            const s = String(Math.floor((timeLeft % 60000) / 1000)).padStart(2, '0');
            const ms = String(timeLeft % 1000).padStart(3, '0');
            document.getElementById('countdown-display').textContent = `倒计时: ${h}:${m}:${s}.${ms}`;
            STATE.countdownTimer = requestAnimationFrame(updateCountdownDisplay);
        }
        updateStatus(`准备就绪，等待时间: ${startTimeStr}`, '#0275d8');
        STATE.countdownTimer = requestAnimationFrame(updateCountdownDisplay);
    }

    async function clickAndRefresh(interval) {
        if (document.body.innerText.includes(CONFIG.failureText)) {
            updateStatus('页面已失效，停止循环。', '#d9534f');
            await GM_setValue('isLoopingActive', false);
            return;
        }

        try {
            updateStatus('正在查找提交按钮...', '#0275d8');
            const submitButton = await waitForElement(CONFIG.submitButtonSelector, 3000);
            if (submitButton.disabled) {
                updateStatus('按钮已被禁用，即将刷新...', '#f0ad4e');
            } else {
                submitButton.click();
                updateStatus(`已点击! ${interval}ms后刷新页面...`, '#5cb85c');
            }
        } catch (error) {
            updateStatus('未找到按钮，即将刷新...', '#f0ad4e');
            GM_log(error.message);
        }

        setTimeout(async () => {
            const stillActive = await GM_getValue('isLoopingActive', false);
            if (stillActive) {
                window.location.reload();
            } else {
                updateStatus('循环已由用户停止。', '#d9534f');
            }
        }, interval);
    }

    function stopGrabbing(reason) {
        if (STATE.countdownTimer) cancelAnimationFrame(STATE.countdownTimer);
        STATE.countdownTimer = null;
        GM_setValue('isLoopingActive', false);
        const allSelected = STATE.screenId && STATE.skuId && STATE.buyerId;
        const startBtn = document.getElementById('start-grabbing-btn');
        if (startBtn) startBtn.disabled = !allSelected;
        const immediateBtn = document.getElementById('immediate-grab-btn');
        if (immediateBtn) immediateBtn.disabled = !allSelected;
        document.getElementById('stop-grabbing-btn')?.setAttribute('disabled', 'true');
        updateStatus(`已停止: ${reason}`, '#d9534f');
    }

    // --- UI界面与交互 ---
    function updateStatus(message, color = 'black') {
        const statusEl = document.getElementById('status-display');
        if (statusEl) {
            statusEl.textContent = message;
            statusEl.style.color = color;
        }
        GM_log(`[抢票助手] ${message}`);
    }

    function populateScreenSelector() {
        const screenSelect = document.getElementById('screen-select');
        screenSelect.innerHTML = '<option value="">--- 请选择场次 ---</option>';
        STATE.skuData.screen_list.forEach(screen => {
            const option = document.createElement('option');
            option.value = screen.id;
            option.textContent = screen.name;
            screenSelect.appendChild(option);
        });
        screenSelect.disabled = false;
        screenSelect.addEventListener('change', (e) => {
            populateTicketSelector(e.target.value);
            STATE.screenId = e.target.value;
            STATE.skuId = null;
            checkAllSelected();
        });
    }

    function populateTicketSelector(selectedScreenId) {
        const ticketSelect = document.getElementById('sku-select');
        const screen = STATE.skuData.screen_list.find(s => s.id == selectedScreenId);
        ticketSelect.innerHTML = '<option value="">--- 请选择票种 ---</option>';
        if (screen && screen.ticket_list) {
            screen.ticket_list.forEach(ticket => {
                const option = document.createElement('option');
                option.value = ticket.id;
                const priceYuan = ticket.price / 100;
                option.textContent = `${ticket.desc} (¥${priceYuan.toFixed(2)})`;
                ticketSelect.appendChild(option);
            });
            ticketSelect.disabled = false;
            ticketSelect.addEventListener('change', (e) => {
                STATE.skuId = e.target.value;
                checkAllSelected();
            });
        } else {
            ticketSelect.disabled = true;
        }
    }

    function populateBuyerSelector() {
        const buyerSelect = document.getElementById('buyer-select');
        buyerSelect.innerHTML = '<option value="">--- 请选择购票人 ---</option>';
        STATE.buyerData.forEach(buyer => {
            const option = document.createElement('option');
            option.value = buyer.id;
            const isDefault = buyer.is_default ? ' [默认]' : '';
            option.textContent = `${buyer.name}${isDefault}`;
            buyerSelect.appendChild(option);
        });
        buyerSelect.disabled = false;
        buyerSelect.addEventListener('change', (e) => {
            STATE.buyerId = e.target.value;
            checkAllSelected();
        });
    }

    function checkAllSelected() {
        const allSelected = STATE.screenId && STATE.skuId && STATE.buyerId;
        document.getElementById('start-grabbing-btn').disabled = !allSelected;
        document.getElementById('immediate-grab-btn').disabled = !allSelected;
    }

    function createDetailControlPanel() {
        const panel = document.createElement('div');
        panel.id = 'ticket-helper-panel';
        panel.innerHTML = `
            <div id="ticket-helper-header">B站抢票助手 (可拖动)</div>
            <div class="control-row-center">
                <button id="fetch-info-btn">1. 获取信息</button>
            </div>
            <div class="control-row">
                <label for="screen-select">选择场次</label>
                <select id="screen-select" disabled><option>请先获取信息</option></select>
            </div>
            <div class="control-row">
                <label for="sku-select">选择票种</label>
                <select id="sku-select" disabled><option>请先选择场次</option></select>
            </div>
             <div class="control-row">
                <label for="buyer-select">选择购票人</label>
                <select id="buyer-select" disabled><option>请先获取信息</option></select>
            </div>
            <hr>
            <div class="control-row">
                <label for="start-time-input">定时抢票时间</label>
                <input type="text" id="start-time-input" placeholder="20:00:00.000">
            </div>
            <div class="control-row">
                <label for="interval-input">刷新间隔(ms)</label>
                <input type="number" id="interval-input" value="500">
            </div>
            <div class="control-row-center">
                <button id="start-grabbing-btn" disabled>定时抢票</button>
                <button id="immediate-grab-btn" class="secondary" disabled>立即抢票</button>
            </div>
            <div class="control-row-center">
                 <button id="stop-grabbing-btn" disabled>停止操作</button>
            </div>
            <div id="status-display">状态: 空闲</div>
            <div id="countdown-display"></div>
            <hr>
            <div class="control-row-center">
                <button id="donate-btn">打赏支持</button>
            </div>
        `;

        // 创建打赏弹窗的HTML，并附加到body
        const modal = document.createElement('div');
        modal.id = 'donate-modal';
        modal.className = 'modal-overlay';
        modal.style.display = 'none'; // 默认隐藏
        modal.innerHTML = `
            <div class="modal-content">
                <span class="modal-close">&times;</span>
                <h2>如果觉得好用，可以请我喝杯咖啡~</h2>
                <p>您的支持是作者更新的最大动力！</p>
                <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAlgAAAJYCAYAAAC+ZpjcAAAAAXNSR0IArs4c6QAAIABJREFUeF7tndFyXcmNBKn//2htUCRl2d7diDlZYlX3TT+7G0CigC4ecmZ+/Pz58+eb/5OABCQgAQlIQAISiBH4ocGKsfQiCUhAAhKQgAQk8IuABkshSEACEpCABCQggTABDVYYqNdJQAISkIAEJCABDZYakIAEJCABCUhAAmECGqwwUK+TgAQkIAEJSEACGiw1IAEJSEACEpCABMIENFhhoF4nAQlIQAISkIAENFhqQAISkIAEJCABCYQJaLDCQL1OAhKQgAQkIAEJaLDUgAQkIAEJSEACEggT0GCFgXqdBCQgAQlIQAIS0GCpAQlIQAISkIAEJBAmoMEKA/U6CUhAAhKQgAQkoMFSAxKQgAQkIAEJSCBMQIMVBup1EpCABCQgAQlIQIOlBiQgAQlIQAISkECYgAYrDNTrJCABCUhAAhKQgAZLDUhAAhKQgAQkIIEwAQ1WGKjXSUACEpCABCQgAQ2WGpCABCQgAQlIQAJhAhqsMFCvk4AEJCABCUhAAhosNSABCUhAAhKQgATCBDRYYaBeJwEJSEACEpCABDRYakACEpCABCQgAQmECWiwwkC9TgISkIAEJCABCWiw1IAEJCABCUhAAhIIE9BghYF6nQQkIAEJSEACEtBgqQEJSEACEpCABCQQJqDBCgP1OglIQAISkIAEJKDBUgMSkIAEJCABCUggTECDFQbqdRKQgAQkIAEJSECDpQYkIAEJSEACEpBAmMCEwfrx40e4LK/7bgI/f/787pDxeAs6bHOkDNr5J0RBGdAcKMNE/u0caHzag/fzCY6JPLzjOYG2jjRYz3vnyT8ItIWcaMbCQm1zpAza+d+gA8qQ9vCdYTsHGv8GHSRqePU72jrSYL26AkP1t4WcKCPxMNE82hwpg3b+lP/ClwvKkPZQg/WhogTHhB694zkBOkvPI39q6Gc7A4VMezhxfkBGmMPCQm1zpAza+WMRDOwjypD2UIOlwUrM0cIddJZoDX7BogQ9/4tAW8iJNiQeJppHmyNl0M6f8l/4ckEZ0h4m5pnmQBncoINEDa9+R1tHGqxXV2Co/raQE2XQRyGRQ5sjZdDOP9EDyoDmQBkm8m/nQOPTHiwY7UQNr35HW0carFdXYKj+tpATZSQeJppHmyNl0M6f8l94WClD2kO/YH2oKMExoUfveE6AztLzyJ8a8m+wKELPJxbyAsWFhVpfCPBfmdLOP6Gjtg4ow0T+7Rxo/Bt0kKjh1e9o68gvWK+uwFD9bSEnykg8TDSPNkfKoJ0/5b/w5YIypD1M/MBEc6AMbtBBooZXv6OtIw3WqyswVH9byIky6KOQyKHNkTJo55/oAWVAc6AME/m3c6DxaQ8WjHaihle/o60jDdarKzBUf1vIiTISDxPNo82RMmjnT/kvPKyUIe2hX7A+VJTgmNCjdzwnQGfpeeRPDfk3WBSh5xMLeYHiwkKtLwT/Bqv+sFINJHTczoHGT+yTBMdEHt7xnEBbR37Bet47T/5BoC3kRDMWFmqbI2XQzv8GHVCGtIeJH5hoDpTBDTpI1PDqd7R1pMF6dQWG6m8LOVEGfRQSObQ5Ugbt/BM9oAxoDpRhIv92DjQ+7YG/IkwQ7N/R1pEGq6+BKzJoCzkBMfEw0TzaHCmDdv6U/8LDShnSHvoF60NFCY4JPXrHcwJ0lp5H/tSQf4NFEXo+sZAXKC4s1PpC8G+w6g8r1UBCx+0caPzEPklwTOThHc8JtHV0xResNsTn7d85SZfJDT1YYLCQA1ElzZ/E/jpLtUhrOD1+4uuNDO7477Mm5pHc0Z5FkvuvObrhCxYdZgrxhvOnCznRgwUGCzkQljR/EluD9UEgsQ9pH2kO7fgLJjMxC6ffsaADwlCDRehddPZ0ISdascBgIQfCkuZPYmuwNFgpDWiwEpPI76D7hBp9WoEGixK85PzpQk60YYHBQg6EJc2fxE49rrQGutTb8RfMhQwSk3D+HQs6IBQ1WITeRWdPF3KiFQsMFnIgLGn+JLYGyy9YKQ0smMzELJx+B90n9Icdyk+DRQlecv50ISfasMBgIQfCkuZPYqceV1oDXert+AvmQgaJSTj/jgUdEIoaLELvorOnCznRigUGCzkQljR/EluD5ReslAYWTGZiFk6/g+4T+sMO5afBogQvOX+6kBNtWGCwkANhSfMnsVOPK62BLvV2/AVzIYPEJJx/x4IOCEUNFqF30dnThZxoxQKDhRwIS5o/ia3B8gtWSgMLJjMxC6ffQfcJ/WGH8tNgUYKXnD9dyIk2LDBYyIGwpPmT2KnHldZAl3o7/oK5kEFiEs6/Y0EHhKIGi9C76OzpQk60YoHBQg6EJc2fxNZg+QUrpYEFk5mYhdPvoPuE/rBD+WmwKMFLzp8u5EQbFhgs5EBY0vxJ7NTjSmugS70df8FcyCAxCeffsaADQlGDRehddPZ0ISdascBgIQfCkuZPYmuw/IKV0sCCyUzMwul30H1Cf9ih/DRYlOAl508XcqINCwwWciAsaf4kdupxpTXQpd6Ov2AuZJCYhPPvWNABoajBIvQuOnu6kBOtWGCwkANhSfMnsTVYfsFKaWDBZCZm4fQ76D6hP+xQfhosSvCS86cLOdGGBQYLORCWNH8SO/W40hroUm/HXzAXMkhMwvl3LOiAUNRgvb290SaSBqTOutRTJJ/fQ3vwPHLupLOQY/n0poUe3KDlp/y/ztE+UIY0Pq0/cb7NgManDDRYGqxfGqLDnBAyzYEOAz2fYEBzoOdP78F7/af3YaEHpzOkc7CwExd0QDlSHVEGND6tX4MVMBe0CYnzVEgLQqY5JDiSO2gPSOzU2dN7oMHKKOEGLVMSdBYoQxqf1p8432ZA41MGGiwNll+w6BR9nm8Pc6IMl3qCIrtjoQc3aJl1of9Vf0EHlCHVEWVA49P6NVgaLA0WnSINVohg5pr2UqVV0EeFxr/hK2CCAe0D1SGNn2BA72gzoPFp/RosDZYGi06RBitEMHNNe6nSKhYe1tMZ0h68n6d9oAxp/AQDekebAY1P69dgBQaJNiFxngqJDjONn1hoCY7kjgQDEj9xluogkQO94/Q+LPTgdIZUQ4l9RBku6IBybDOg8Wn9GiwNll+w6BT5BStEMHNNe6nSKhYe1tMZ0h5osBIE+T/RS2ehrWMNlgZLg5XZJcf/6wESj0oIJbqmvVRR8iP76HSGtAeJWaAMqblIMKB3tBnQ+LR+DdbIQqONpEKiw0zjJxYaZUjPJxjQHOh5qgMaP3H+9D4s9OB0hgkd0T5QhjR+ggG9o82Axqf1a7A0WH7BolPkrwhDBDPXtJcqrWLhYT2dIe1B4gc+ynBBB5RjmwGNT+vXYGmwNFh0ijRYIYKZa9pLlVax8LCezpD2QIOVIOjfYGmwNFgarMwu8W+wQhzpNaebAw0WVUDmPO0D1SGNn6HAbmkzoPFZ9W9vGiwNlgaLTpFfsEIEM9e0lyqtYuFhPZ0h7YFfsBIE/YKlwdJgabAyu8QvWCGO9JrTzYEGiyogc572geqQxs9QYLe0GdD4rHq/YEXMBW1C4jwVEh1mGj/xE2OCI7kjwYDET5ylOkjkQO84vQ8LPTidIdVQYh9Rhgs6oBzbDGh8Wr9fsPyCFTGZCSGfvlASDOhA0/On9+C9/tP7sNCD0xnSOdBgJQjyWaSz0NaxBkuDpcHK7JLIw378QvnxA9FsL8TEw4oABAwi1VDCpNIcbtABrYEypDpMnG8zoPEpAw2WBkuDRafo83ximOlSTeRAcJyevwbro/tUR+qgz5DMcersq+tIg6XB0mCFtgldJonHPZEDweHDSuhtmBsN1kcf2lqm8bkS+Q10H1EGND4loMEKDBJtQuI8FdKCkGkOCY7kDtqDhaVO6r8h/0QNlCHVUWKO2jnQ+LQHCR3QGhJ9THAgd7QZ0Pik9l8a+tnOIGBwaAkKuf/TWmKh0WGg56kOEwwSORAOdJba+Sd6QPgtfD1ayOEGHdAa6CxRHSbOtxnQ+JSBBitg8GgTEuepkOgw0/gLDxvtwwKDRA6Ew4KOSP4LOqQ9pD3QYH0oiHJc6COdBXq+zYDGp/VrsAKDRJuQOE+F1F4miYWW4EjuoD1IMEjkQBgs6Ijkn+gBjU97SHugwdJgUQ1/nW9rmcanHDRYGqyJn9YWHjY6TIlhpo9jIgfC4fT8F3RIe0h7oMHSYJEd8OfZtpZpfMpBg6XB0mDRKfo8nxhm+jgmciA4Ts9fg/XRfaojddBnSOY4dfbVdaTB0mBpsELbhC6TxOOeyIHg8GEl9DbMjQbLL1hcxRtaru9D/ylC/seMKTGSe6iQFh5GmgPhlzhLe6DB4j/1J/rY1iHVUSL/dg40/oIOaA2JPiY4kDvaDGh8Uvuvfa7B0mCtPOynL5TEMFMGiRzIUjk9/8QsEH4LX48WcmjrOKEDWgOdJarDxPk2AxqfMtBg+StCf0VIp+jzfGKY6VJN5EBwnJ5/4mEl/BbMzUIObR0ndEBroLNEdZg432ZA41MGGiwNlgaLTpEG6zdB+ii0F2LiYaVyogxoDzRYHx2kHBf6SLVIz7cZ0Pi0fg1WYJBoExLnqZDayySx0BIcyR20BwkGiRwIgwUdkfwTPaDxaQ9pDzRYGiyq4a/zbS3T+JSDBkuDNfHT2sLDRocpMcz0cUzkQDicnv+CDmkPaQ80WBossgP+PNvWMo1POWiwNFgaLDpFQ+fpQkk8zkM4HqVCGT4K+sch2oN2/jeY1EQNtA9UB1SHifNtBjQ+ZaDB0mBpsOgUDZ2nC+WGpU7bQRnS+LQH7fwT5oQyTDBo94HGpwwT52kfKAManzLQYGmwNFh0iobO04VCF9oQisepUIaPA38epD1o56/B+mgk7QPVAdVh4nybAY1PGWiwNFgaLDpFQ+fpQrlhqdN2UIY0Pu1BO38NlgbrawaoFk+fBQ2WBkuDRV/EofPthTaE4nEqlOHjwH7Bouh+n0/0sP240/gxmOAi2gfKgMYHpX+8q/6b3Pm/74Q2IXGeCmlByDSHBMfT72jr4HR+iV/tUAZ0DqgGaP5+wfILll+wPghosPyC5ResxIsycgd9XOnjPoIBpUEZouCBfdTOX4OlwdJgabB+78EbHhW6VCkDGn9hKdOHceE87QPVwQIDmgNlSOPTHrTzX5jlBIN2H2h8qsPEedoHyoDGpwz8ghX4iZE2IXGeCmlByDSHBMfT72jr4HR+7/lThpQBnYN2/hosv2D5BcsvWH7B+uMlWFjqNAf6sN1wnj6u9kCDlZiDto7oHCRMIs2hzTChgzYDGp8y8AuWX7B+aYgOc0LINAc6DDecp32wBxqsxBy0dUTnYGEnthkmdED7QBnQ+JSBBitgLmgTEuepkBaETHNIcDz9jrYOTufnrwgzHWzPMp0DDVZGB7QPVEc0PqWgwdJg+QWLTtHQebpQ6EIbQvE4FcrwceDPg7QH7fwT5oQyTDBo94HGpwwT52kfKAManzLQYGmwNFh0iobO04VCF9oQisepUIaPA2uwKLrf5xM9pLNAc6DxYzDBRW0GND4o/eNd9V80yv/+iDYhcZ4KiQ4zjb/wU2+iD+07aB+oDtr1J+JThjQH2oN2/guznGDQ7gONT3WYOE/7QBnQ+JSBBssvWH7BolM0dJ4uFLrQhlA8ToUyfBzYL1gUnV+wYgQzF9FZovuIxqcUNFiU4CXnF4S8kEO7nZRBO//2Qkt8PaE10B62478zpDm0dZiI3+5joobT7zi9Bxqs0xUYyn9ByAs5hHA+voYyeBw4dHDhYaYMaQ2nx9dgfQxDu4+hkTz6mtN7oME6Wn655BeEvJBDjuizmyiDZ1Fzp6g5SWRCGdIaTo+vwdJgJeYwcUd7lmgNGixK8JLzC0JeyKHdTsqgnT81J4n8KUNaw+nxNVgarMQcJu5ozxKtQYNFCV5yfkHICzm020kZtPOn5iSRP2VIazg9vgZLg5WYw8Qd7VmiNWiwKMFLzi8IeSGHdjspg3b+1Jwk8qcMaQ2nx9dgabASc5i4oz1LtAYNFiV4yfkFIS/k0G4nZdDOn5qTRP6UIa3h9PgaLA1WYg4Td7RnidagwaIELzm/IOSFHNrtpAza+VNzksifMqQ1nB5fg6XBSsxh4o72LNEaNFiU4CXnF4S8kEO7nZRBO39qThL5U4a0htPja7A0WIk5TNzRniVagwaLErzk/IKQF3Jot5MyaOdPzUkif8qQ1nB6fA2WBisxh4k72rNEa9BgUYKXnF8Q8kIO7XZSBu38qTlJ5E8Z0hpOj6/B0mAl5jBxR3uWaA0aLErwkvMLQl7Iod1OyqCdPzUnifwpQ1rD6fE1WBqsxBwm7mjPEq1Bg0UJXnJ+QcgLObTbSRm086fmJJE/ZUhrOD2+BkuDlZjDxB3tWaI1aLAowUvOLwh5IYd2OymDdv7UnCTypwxpDafH12BpsBJzmLijPUu0Bg0WJXjJ+QUhL+TQbidl0M6fmpNE/pQhreH0+BosDVZiDhN3tGeJ1qDBogQvOb8g5IUc2u2kDNr5U3OSyJ8ypDWcHl+DpcFKzGHijvYs0RquMFgUguc5AfoovWfQHqZ2fBlwDSTMQVsH7fjqMGOw+Fb1Bkog8S6RHDRYhJ5nfxNICLn9sLTj+7BpsBY0sJDDDbPo89AnkHiXSBUaLELPsxqsPzSQGOb2w3J6fL9gvb2pww0GPg99AolZIFVosAg9z2qwNFj/NgV0oVGDp8HaMBdtHdD4ia94Pg99AgkdkCo0WISeZzVYGiwN1n/sAbrUqcmk8RPmguZwAwOfhz4BqkNagQaLEvT8LwIJIbeXaju+D5t/g7WggYUcbphFn4Y+gcS7RKrQYBF6nvULll+w/ILlF6z/2oT0YdNg+bgkCFAd0hw0WJSg5/2C9amBxDC3H5bT4ye+pp7OQB1ufFH3aegTSMwCqUKDReh51i9YfsHyC5ZfsPyC5VswSUCDFfgXTE529sWSSgjZLwf8b5BoH07vgV+wNr7enK7Ddx3RWXixJ2CyXKpDWpRfsChBz/srQn9FGPuSmXjU6FKlOZweP2EuZODDsECA6pDWoMGiBD2vwdJgabCCvypuGzwN1kczaR98GvoENFgKua/CQAYJIdOFRnNox08s9dMZ0B74K0J/RZjQQGIWA2vVKyABug9h+De/YFGCnvcLll+w/ILlF6x/24T0YaNGm8bXYN3xsCV0QEhosAg9z8Ye1sRCo8N0w1I/nQHtQeLrBc3h9B44i/6K8Janjc4i5aDBogQ97xcsv2DFjDY1Nxosf0WY0EDCZPo09AlosPo9MIMRAvRxpcPUjj/ShmoatAepx5VASNRA4i+cpbO4UIM5SIASmPiCRYvw/B0E6MNEl3o7/h1dZFXQHmiwGP/UaTqLqTy8RwJNAhqsJn1j/xsB+rjSpd6Orxwy/2g81QHtA9URjb9wvt2DBQbmIAENlhqYIUAfJrrU2/FnGlFMhPbAL1jF5v0Rms7iRhVmIQFGQIPF+Hk6SIA+rnSpt+MHUR57Fe2BBmuj9XQWN6owCwkwAhosxs/TQQL0caVLvR0/iPLYq2gPNFgbraezuFGFWUiAEdBgMX6eDhKgjytd6u34QZTHXkV7oMHaaD2dxY0qzEICjIAGi/HzdJAAfVzpUm/HD6I89iraAw3WRuvpLG5UYRYSYAQ0WIyfp4ME6ONKl3o7fhDlsVfRHmiwNlpPZ3GjCrOQACOgwWL8PB0kQB9XutTb8YMoj72K9kCDtdF6OosbVZiFBBgBDRbj5+kgAfq40qXejh9EeexVtAcarI3W01ncqMIsJMAIaLAYP08HCdDHlS71dvwgymOvoj3QYG20ns7iRhVmIQFGQIPF+Hk6SIA+rnSpt+MHUR57Fe2BBmuj9XQWN6owCwkwAhosxs/TQQL0caVLvR0/iPLYq2gPNFgbraezuFGFWUiAEdBgMX6eDhKgjytd6u34QZTHXkV7oMHaaD2dxY0qzEICjIAGi/HzdJAAfVzpUm/HD6I89iraAw3WRuvpLG5UYRYSYAQ0WIyfp4ME6ONKl3o7fhDlsVfRHmiwNlpPZ3GjCrOQACMwYbDoUqXDTOOzFtxxmvYgQYH28YYaEhzJHZQh7SHJ/etsuwYaP8GA9oHW0I7/zpDmkOjD6XdQHZxevwbLQYpoeGGQ6EK8oYZIM8EllCHtIUj999F2DTR+ggHtA62hHV+DlVDR2xvVQSaL3i0aLA1WRH0Lg7SwlClMWgONT89THSzU366Bxqc9TJgLWgPVAY2fYJDow+l3JPpwMgMNlgYrot+FQVpYyhQmrYHGp+epDhbqb9dA49MeJswFrYHqgMZPMEj04fQ7En04mYEGS4MV0e/CIC0sZQqT1kDj0/NUBwv1t2ug8WkPE+aC1kB1QOMnGCT6cPodiT6czECDpcGK6HdhkBaWMoVJa6Dx6Xmqg4X62zXQ+LSHCXNBa6A6oPETDBJ9OP2ORB9OZqDB0mBF9LswSAtLmcKkNdD49DzVwUL97RpofNrDhLmgNVAd0PgJBok+nH5Hog8nM9BgabAi+l0YpIWlTGHSGmh8ep7qYKH+dg00Pu1hwlzQGqgOaPwEg0QfTr8j0YeTGWiwNFgR/S4M0sJSpjBpDTQ+PU91sFB/uwYan/YwYS5oDVQHNH6CQaIPp9+R6MPJDDRYGqyIfhcGaWEpU5i0Bhqfnqc6WKi/XQONT3uYMBe0BqoDGj/BINGH0+9I9OFkBhosDVZEvwuDtLCUKUxaA41Pz1MdLNTfroHGpz1MmAtaA9UBjZ9gkOjD6Xck+nAyAw2WBiui34VBWljKFCatgcan56kOFupv10Dj0x4mzAWtgeqAxk8wSPTh9DsSfTiZgQZLgxXR78IgLSxlCpPWQOPT81QHC/W3a6DxaQ8T5oLWQHVA4ycYJPpw+h2JPpzMQIOlwYrod2GQFpYyhUlroPHpeaqDhfrbNdD4tIcJc0FroDqg8RMMEn04/Y5EH05moMHSYEX0uzBIC0uZwqQ10Pj0PNXBQv3tGmh82sOEuaA1UB3Q+AkGiT6cfkeiDycz0GBpsCL6XRikhaVMYdIaaHx6nupgof52DTQ+7WHCXNAaqA5o/ASDRB9OvyPRh5MZTBgsCnBhGNs10PgLg9DuI41Pe3DDeXX09tbWUaIHN9RA5+l0Bu38Kf/E+cQskDw0WG9vb+0mLPy0dAMDWoMLiaySj7O0BzwDbnBoDW0d0fzdRx8qPL2P7fwTs0zvSMwCyUGDdcmjQETgw7ixUGkPF863F1riYaQ1tB82mn+CIdViogaaw+l9bOdP+SfOt3WkwdJg+eXhc5JdSHyltRdawhzQGto6ovknGFIlJWqgOZzex3b+lH/ifFtHGiwNlgZLg5XYZepoREeJR6X9OCdqoKI+nUE7f8o/cb6tIw2WBsuHceRhTCyU9h3thZb4+kJraD9sNP8EQ6rDRA00h9P72M6f8k+cb+tIg6XB0mBpsBK7TB2N6CjxqLQf50QNVNSnM2jnT/knzrd1pMHSYPkwjjyMiYXSvqO90BJfX2gN7YeN5p9gSHWYqIHmcHof2/lT/onzbR1psDRYGiwNVmKXqaMRHSUelfbjnKiBivp0Bu38Kf/E+baONFgaLB/GkYcxsVDad7QXWuLrC62h/bDR/BMMqQ4TNdAcTu9jO3/KP3G+rSMNlgZLg6XBSuwydTSio8Sj0n6cEzVQUZ/OoJ0/5Z8439aRBkuD5cM48jAmFkr7jvZCS3x9oTW0Hzaaf4Ih1WGiBprD6X1s50/5J863daTB0mBpsDRYiV2mjkZ0lHhU2o9zogYq6tMZtPOn/BPn2zrSYGmwfBhHHsbEQmnf0V5oia8vtIb2w0bzTzCkOkzUQHM4vY/t/Cn/xPm2jjRYGiwNlgYrscvU0YiOEo9K+3FO1EBFfTqDdv6Uf+J8W0caLA2WD+PIw5hYKO072gst8fWF1tB+2Gj+CYZUh4kaaA6n97GdP+WfON/W0RUGK9EIegcVMxUCjU/rp/nT+InzlGGCAc0hwaF5xwLDRA6EIdVAIv+FHJoM32MnODZroPlTDSwwJPwTZzVYCYpvb29UjAvDQFDQ/Ens1Nl2Dxe+HKRYPr0noaOFPj6tP6EBGfJ9vGAO2jqm8RcYkjlMnNVgJShqsOo/7SXaSBfKwsOW4NC8Y4FhIgfC8AYdns5wwRy0dUDjLzAkc5g4q8FKUNRgabBCv1JILLWQpCvXJB5myjCRA4G3kP9CDk2GC+ag3QMaf4Eh0VDirAYrQVGDpcHSYEUmKWFu6MOQyIHAWMh/IYcmwwVz0O4Bjb/AkGgocVaDlaCowdJgabAik5QwN/RhSORAYCzkv5BDk+GCOWj3gMZfYEg0lDirwUpQ1GBpsDRYkUlKmBv6MCRyIDAW8l/IoclwwRy0e0DjLzAkGkqc1WAlKGqwNFgarMgkJcwNfRgSORAYC/kv5NBkuGAO2j2g8RcYEg0lzmqwEhQ1WBosDVZkkhLmhj4MiRwIjIX8F3JoMlwwB+0e0PgLDImGEmc1WAmKGiwNlgYrMkkJc0MfhkQOBMZC/gs5NBkumIN2D2j8BYZEQ4mzGqwERQ2WBkuDFZmkhLmhD0MiBwJjIf+FHJoMF8xBuwc0/gJDoqHEWQ1WgqIGS4OlwYpMUsLc0IchkQOBsZD/Qg5NhgvmoN0DGn+BIdFQ4qwGK0FRg6XB0mBFJilhbujDkMiBwFjIfyGHJsMFc9DuAY2/wJBoKHFWg5WgqMHSYGmwIpOUMDf0YUjkQGAs5L+QQ5Phgjlo94DGX2BINJQ4q8FKUNRgabA0WJFJSpgb+jAkciAwFvJfyKHJcMEctHtA4y8wJBpKnNVgJShqsDRYGqzIJCXMDX0YEjkQGAv5L+TQZLhgDto9oPEXGBINJc5qsALmKNGI9h3tRyVRf2IhJPIgd9A+UAY0Pqn9/SzNn8a/4Xy7hwmGVAcySHTh/DvaOtBgudR/TVFbiIlRpksrmf7VAAAgAElEQVQ5kQO9g/aBMqDxaf00fxr/hvPtHiYYUh3IINGF8+9o60CDpcHSYA3tEboQTn+YaP5DraylQjVUS/yPwFQHMljoYj+Htg40WBosDVZ/D/zOgC6E0x8mmv9QK2upUA3VEtdg/Rt6Z4ErsT0LGiwNlgaLz3HsBroQ6FKm8SkImj+Nf8P5dg8TDKkOZJDowvl3tHWgwdJgabCG9ghdCKc/TDT/oVbWUqEaqiXuFyy/YIXF154FDZYGS4MVHmpyHV0I1KDQ+KT297M0fxr/hvPtHiYYUh3IINGF8+9o60CD5VLXYA3tEboQTn+YaP5DraylQjVUS9wvWH7BCouvPQsaLA2WBis81OQ6uhCoQaHxSe1+waL0Ps63e5io4nQdLzBI5HD6He1Z0GBpsFzKQ1uELoTTHyaa/1Ara6lQDdUS9wuWX7DC4mvPggZLg6XBCg81uY4uBGpQaHxSu1+wKD2/YH0RbOs40Uk6y4kcTr+jrQMNlgZLgzW0RehCoEuZxqcoaf40/g3n2z1MMKQ6kEGiC+ff0daBBkuDpcEa2iN0IZz+MNH8h1pZS4VqqJa4vyL0V4Rh8bVnQYOlwdJghYeaXEcXAjUoND6p3V8RUnr+itBfEWY0dMst9X32s53BQCfpozRQAk7hBhnc0EfaB8qAxqdCpPnT+Decb/cwwZDqQAaJLpx/R1sHfsHyC5ZfsIb2CF0Ipz9MNP+hVtZSoRqqJe6vCP0VYVh87VnQYGmwNFjhoSbX0YVADQqNT2r3V4SUnr8i9FeEGQ3dckt9n/krwg0ptR9GGn+DIsuiPYws+8zpG3TQ7uMNDKmaaA8WGNIaKMM2g0T9tIZEDrQP5LxfsAi94Nm2EGn8IIraVacPcwLcDTpo9/EGhlRLtAcLDGkNlGGbQaJ+WkMiB9oHcl6DRegFz7aFSOMHUdSuOn2YE+Bu0EG7jzcwpFqiPVhgSGugDNsMEvXTGhI50D6Q8xosQi94ti1EGj+IonbV6cOcAHeDDtp9vIEh1RLtwQJDWgNl2GaQqJ/WkMiB9oGc12AResGzbSHS+EEUtatOH+YEuBt00O7jDQyplmgPFhjSGijDNoNE/bSGRA60D+S8BovQC55tC5HGD6KoXXX6MCfA3aCDdh9vYEi1RHuwwJDWQBm2GSTqpzUkcqB9IOc1WIRe8GxbiDR+EEXtqtOHOQHuBh20+3gDQ6ol2oMFhrQGyrDNIFE/rSGRA+0DOa/BIvSCZ9tCpPGDKGpXnT7MCXA36KDdxxsYUi3RHiwwpDVQhm0GifppDYkcaB/IeQ0WoRc82xYijR9EUbvq9GFOgLtBB+0+3sCQaon2YIEhrYEybDNI1E9rSORA+0DOa7AIveDZthBp/CCK2lWnD3MC3A06aPfxBoZUS7QHCwxpDZRhm0GiflpDIgfaB3Jeg0XoBc+2hUjjB1HUrjp9mBPgbtBBu483MKRaoj1YYEhroAzbDBL10xoSOdA+kPMaLEIveLYtRBo/iKJ21enDnAB3gw7afbyBIdUS7cECQ1oDZdhmkKif1pDIgfaBnNdgEXrBs20h0vhBFLWrTh/mBLgbdNDu4w0MqZZoDxYY0hoowzaDRP20hkQOtA/kvAaL0AuebQuRxg+iqF11+jAnwN2gg3Yfb2BItUR7sMCQ1kAZthkk6qc1JHKgfSDnNViEXvBsW4g0fhBF7arThzkB7gYdtPt4A0OqJdqDBYa0BsqwzSBRP60hkQPtAzmvwSL0gmfbQqTxgyhqV50+zAlwN+ig3ccbGFIt0R4sMKQ1UIZtBon6aQ2JHGgfyHkNFqEXPPvqQgyirF1Fe5hIvL2QKIN2/u89OL0Gmv87A9oHmgONn5glWgPNoc2gXT/ll9AxzUGDRQmGzlMxt4cxhOHoa2gPE8W3dUAZtPPXYH2okPZBHfBppj2gGdAe0viJ83WGP9sZJChecAcVs23si4D2MFFBWweUQTt/DZYG62sOqZbpPLdnoV0/5Zf4QYHm4BcsSjB0noq5PYwhDEdfQ3uYKL6tA8qgnb8GS4OlwfogQGc5sc/oHe19osGiHQydp2JuCymE4ehraA8Txbd1QBm08088LO0aaA8SP/nTHNoMEzqg89xmQHtI60+crzP0V4SJNvI7qJjbQuIEzr+B9jBBoK0DyqCdf+JhbddAe6DB2viCc4OOEjuN3FFnqMEi7cudpUuxLaQciXNvoj1MVN7WAWXQzl+D9aFC2gd1wKeZ9oBmQHtI4yfO1xlqsBJt5HdQMbeFxAmcfwPtYYJAWweUQTt/DZYG62sOqZbpPLdnoV0/5Zf4QYHm4N9gUYKh81TM7WEMYTj6GtrDRPFtHVAG7fw1WBosDdYHATrLiX1G72jvEw0W7WDoPBVzW0ghDEdfQ3uYKL6tA8qgnX/iYWnXQHuQ+Mmf5tBmmNABnec2A9pDWn/ifJ2hvyJMtJHfQcXcFhIncP4NtIcJAm0dUAbt/BMPa7sG2gMN1sYXnBt0lNhp5I46Qw0WaV/uLF2KbSHlSJx7E+1hovK2DiiDdv4arA8V0j6oAz7NtAc0A9pDGj9xvs5Qg5VoI7+DirktJE7g/BtoDxME2jqgDNr5a7A0WF9zSLVM57k9C+36Kb/EDwo0B/8GixIMnadibg9jCMPR19AeJopv64AyaOevwdJgabA+CNBZTuwzekd7n2iwaAdD56mY20IKYTj6GtrDRPFtHVAG7fwTD0u7BtqDxE/+NIc2w4QO6Dy3GdAe0voT5+sM/RVhoo38DirmtpA4gfNvoD1MEGjrgDJo5594WNs10B5osDa+4Nygo8ROI3fUGS4YLLoQKEQa/4aFRBnQHiQeNjKICz1M5EAZ0PNURzS+DBME+R+5Z7J4fsuCDp9nnzlJd/ICQ1pDhuTzWyZ+RUgbSZtA4yeWOs2hzYDG12B9DHGC4/N1wE9SHfMMZCjDO/5+iPaR7hJnmXbg7U2DFfpjvraYT4+vwdJg8XUmQxl+EFgwB6lePL2n/SY8zfvPc7SGRA7kDg1WaBipEOhCOD3+wlJsM/QLFlll/zpL+5jJ4vktdBc8jyzDBLuVO+gcqEPeSQ2WBivyEx8dZg2WX1/4OpOhDP2C9aUBupM1WHyaNFgaLA3W5xwtLCSaA18J7AaXMuO38IOGX1J5DxduoLvEWeZd1GBpsDRYGiy+ST5vcClzlDK8gyGvgt2gwWL8Eqc1WBosDZYGK7FLIjpKJEIflkQO5A4NFqHnrwj9FSHXT+oGDZYGK/IwJh619sNCa0jkT3NILYan9yQYPI2delhofHpehpSg/xThO0G6S9RhQIf+i0Yzw9gW8+nx36XcHug2w8RS5CuB3dDuoQxZ/zSpGX4LtyzsM8qB1kDj0/N+wQo97FQI9GE6Pb4G62OUaR/pQqDnqY5pfBkmCKrDDMXuLXSXOMu8fxosDdYvFdFhosOcyIGOA62BMtQc0A5qUjMENVgpjs17FvYZrZ/WQOPT8xqsgLlIPIz0caZCbMfXYGkO6DL7Ok9nIZXH03voLD6N++c5GSYodu+gPVSHvH8aLA2WX7A+52hhIdEc+EpgN7iUGb+FHzQSPzByCuyGBR2yCvhpuksWGNIaOEV2gwZLg6XB0mCxLfLHaZcyRynDOxjyKtgN1JyoQ8b/1w9L/lOE/O+PEj/xUTG3h4nGX/jJndZAe5jQEV8J7IYEA5aBfz9E+anDBMH+HQv7jFKgNdD49PyEwaJF3HC+/TBRISfypzncoANaA+0D7UE7PuWXMPqUIa2B9iBhsBI5UA6nn6c6WugBreH0HmqwRjrYHgY6CIn8aQ4jraymQftAe9COn4B/eg00fw1WQkX8jvYs8grO/5pMGWiwKMHQ+cRSJKksDDPNgdR/y1mqI9qDdvxEH0+vgeavwUqoiN/RnkVegQZLg5VQUeCOxFIkaSwMM82B1H/LWaoj2oN2/EQfT6+B5q/BSqiI39GeRV6BBkuDlVBR4I7EUiRpLAwzzYHUf8tZqiPag3b8RB9Pr4Hmr8FKqIjf0Z5FXoEGS4OVUFHgjsRSJGksDDPNgdR/y1mqI9qDdvxEH0+vgeavwUqoiN/RnkVegQZLg5VQUeCOxFIkaSwMM82B1H/LWaoj2oN2/EQfT6+B5q/BSqiI39GeRV6BBkuDlVBR4I7EUiRpLAwzzYHUf8tZqiPag3b8RB9Pr4Hmr8FKqIjf0Z5FXoEGS4OVUFHgjsRSJGksDDPNgdR/y1mqI9qDdvxEH0+vgeavwUqoiN/RnkVegQZLg5VQUeCOxFIkaSwMM82B1H/LWaoj2oN2/EQfT6+B5q/BSqiI39GeRV6BBkuDlVBR4I7EUiRpLAwzzYHUf8tZqiPag3b8RB9Pr4Hmr8FKqIjf0Z5FXoEGS4OVUFHgjsRSJGksDDPNgdR/y1mqI9qDdvxEH0+vgeavwUqoiN/RnkVegQZLg5VQUeCOxFIkaSwMM82B1H/LWaoj2oN2/EQfT6+B5q/BSqiI39GeRV6BBkuDlVBR4I7EUiRpLAwzzYHUf8tZqiPag3b8RB9Pr4Hmr8FKqIjf0Z5FXoEGS4OVUFHgjsRSJGksDDPNgdR/y1mqI9qDdvxEH0+vgeavwUqoiN/RnkVegQZLg5VQUeCOxFIkaSwMM82B1H/LWaoj2oN2/EQfT6+B5q/BSqiI39GeRV6BBusKg0UXChVyQojtOyjDRP7tPlAGifxpDrQPtIZ2/rT+hLlI5NC+44Y+UoavPgu0fsr//TzVYbsGDdabLjsh5MQw1Yfhxw9URiJ/ulBQAYFZaOdP69dgfRC8oY9UC3SeT2dI66f8Ezps16DBCjwqCSG171hYBvVh0GC90R4s6IjOEmVA4y+cv6GPlCPVwekMaf2UvwYrQTBwBxXygpACGNAVlCEK/nm43QfKIJE/zYH2gdbQzp/W7xcsv2B9aejVZ4HWn5hFuk/aNfgFyy9YM78SqA+DX7D8guU+mNkHiQea3EH3ETUHJPfEWVp/IgfKsF2DBsuFOrNQ68OgwdJguQ9m9kHigSZ30H1EzQHJPXGW1p/IgTJs16DBcqHOLNT6MGiwNFjug5l9kHigyR10H1FzQHJPnKX1J3KgDNs1aLBcqDMLtT4MGiwNlvtgZh8kHmhyB91H1ByQ3BNnaf2JHCjDdg0aLBfqzEKtD4MGS4PlPpjZB4kHmtxB9xE1ByT3xFlafyIHyrBdgwbLhTqzUOvDoMHSYLkPZvZB4oEmd9B9RM0ByT1xltafyIEybNegwXKhzizU+jBosDRY7oOZfZB4oMkddB9Rc0ByT5yl9SdyoAzbNWiwXKgzC7U+DBosDZb7YGYfJB5ocgfdR9QckNwTZ2n9iRwow3YNGiwX6sxCrQ+DBkuD5T6Y2QeJB5rcQfcRNQck98RZWn8iB8qwXYMGy4U6s1Drw6DB0mC5D2b2QeKBJnfQfUTNAck9cZbWn8iBMmzXoMFyoc4s1PowaLA0WO6DmX2QeKDJHXQfUXNAck+cpfUncqAM2zVosFyoMwu1PgwaLA2W+2BmHyQeaHIH3UfUHJDcE2dp/YkcKMN2DRosF+rMQq0PgwZLg+U+mNkHiQea3EH3ETUHJPfEWVp/IgfKsF3DhME6HWJCSPSOGxjSGijD9jDS/N/PyzBBkd3R7gHL/uM0nQXKoB0/wZDecQODdg00Pu2hBosSHDnfXmgJDLQGmkN7GGn+GqwEQX5HW8e8Ag1WgiG9g+6jBR22a6DxaQ81WJTgyHk6TG0hag4yQqI6oFks6IjWQM+3e0Dz9wtWgiC/g87Sgg7bNdD4tIsaLEpw5DwdprYQNVgZIVEd0CwWdERroOfbPaD5a7ASBPkddJYWdNiugcanXdRgUYIj5+kwtYWowcoIieqAZrGgI1oDPd/uAc1fg5UgyO+gs7Sgw3YNND7togaLEhw5T4epLUQNVkZIVAc0iwUd0Rro+XYPaP4arARBfgedpQUdtmug8WkXNViU4Mh5OkxtIWqwMkKiOqBZLOiI1kDPt3tA89dgJQjyO+gsLeiwXQONT7uowaIER87TYWoLUYOVERLVAc1iQUe0Bnq+3QOavwYrQZDfQWdpQYftGmh82kUNFiU4cp4OU1uIGqyMkKgOaBYLOqI10PPtHtD8NVgJgvwOOksLOmzXQOPTLmqwKMGR83SY2kLUYGWERHVAs1jQEa2Bnm/3gOavwUoQ5HfQWVrQYbsGGp92UYNFCY6cp8PUFqIGKyMkqgOaxYKOaA30fLsHNH8NVoIgv4PO0oIO2zXQ+LSLGixKcOQ8Haa2EDVYGSFRHdAsFnREa6Dn2z2g+WuwEgT5HXSWFnTYroHGp13UYFGCI+fpMLWFqMHKCInqgGaxoCNaAz3f7gHNX4OVIMjvoLO0oMN2DTQ+7aIGixIcOU+HqS1EDVZGSFQHNIsFHdEa6Pl2D2j+GqwEQX4HnaUFHbZroPFpFzVYlODIeTpMbSFqsDJCojqgWSzoiNZAz7d7QPPXYCUI8jvoLC3osF0DjU+7qMGiBEfO02FqC1GDlRES1QHNYkFHtAZ6vt0Dmr8GK0GQ30FnaUGH7RpofNrFCYOFi/jxg15RP18XAmTYzj/RwBsWEuWwwIDWQLVIGbTjU34Jg0VzaPdg4Qc+ylAdUoL8vAaLM4zcQIeBJrGw0GgN9DxlQOPf8LAlGNA76CxRHbTjU3436JD2QIP19kbn4AYd0ho0WJRg6HxiIZBU6DC18ye1f52lDBI5tDkuMKAcKUPKoB2f8tNgfRCkOkj0gdyhDgm9zFkNVoYjvoUOA02ALpN2/rT+lYXa5kh1kOgDvYMypAza8Sk/DZYGy32YmKK3Nw1WhiO+hS5lmkD7UaH5J85TBokcTtdBggG9gzKkOmjHp/w0WBosDVZiijRYGYqBW+hSpim0HxWaf+I8ZZDI4XQdJBjQOyhDqoN2fMpPg6XB0mAlpkiDlaEYuIUuZZpC+1Gh+SfOUwaJHE7XQYIBvYMypDpox6f8NFgaLA1WYoo0WBmKgVvoUqYptB8Vmn/iPGWQyOF0HSQY0DsoQ6qDdnzKT4OlwdJgJaZIg5WhGLiFLmWaQvtRofknzlMGiRxO10GCAb2DMqQ6aMen/DRYGiwNVmKKNFgZioFb6FKmKbQfFZp/4jxlkMjhdB0kGNA7KEOqg3Z8yk+DpcHSYCWmSIOVoRi4hS5lmkL7UaH5J85TBokcTtdBggG9gzKkOmjHp/w0WBosDVZiijRYGYqBW+hSpim0HxWaf+I8ZZDI4XQdJBjQOyhDqoN2fMpPg6XB0mAlpkiDlaEYuIUuZZpC+1Gh+SfOUwaJHE7XQYIBvYMypDpox6f8NFgaLA1WYoo0WBmKgVvoUqYptB8Vmn/iPGWQyOF0HSQY0DsoQ6qDdnzKT4OlwdJgJaZIg5WhGLiFLmWaQvtRofknzlMGiRxO10GCAb2DMqQ6aMen/DRYGiwNVmKKNFgZioFb6FKmKbQfFZp/4jxlkMjhdB0kGNA7KEOqg3Z8yk+DpcHSYCWmaMRgudAyzSS3LDwKCzk0GZLYX2fpLCVyIHdQDZDYqbO0B5QBjZ/iQO6RAaG3c5b2caeSZ5lM/Mee6UKgTaTxn6HfOrXAcCEH0hWaP4mtwUrQy9xB9wnVEY2focBukQHjt3Ka9nGljqd5aLDe3t5uWEhPBfB1jg5CguFCDoQjzZ/E1mAl6GXuoLNAdUTjZyiwW2TA+K2cpn1cqeNpHhosDdYv7dBBSCz1hRyeDlKCIYmtwUrQy9xBZ+H0OUhQlEGCYv8O2sd+BSwDDZYGS4PFZuj36YVlQh/3EIrH1ywwfJz850HaA8qAxqf1J87LIEGxfwftY78CloEGS4OlwWIzpMEK8Vv5CkjLoQaHPko0Pq0/cV4GCYr9O2gf+xWwDDRYGiwNFpshDVaInwbrAyR9lDRY/l1tcCTRVVTLKPjAYQ2WBmtmqdNhbD8sNP/EPmgzoDUsMKQ10B5QBjQ+rT9xXgYJiv07aB/7FbAMNFgaLA0WmyG/YIX4Jb7eBFN5fBU1OPRRovEfFx48KIMgzOJVtI/F1COhNVgaLA1WZJT4r3YSaZz+uN6wkGkPKAMaP6FDeocMKMGN87SPG1U8z0KDpcHSYD2fn387ubBMTn9cFxhSOdAeUAY0Pq0/cV4GCYr9O2gf+xWwDDRYGiwNFpshf0UY4uevCD9A0kdJg+UfuQdHEl1FtYyCDxzWYGmwZpY6Hcb2w0LzT+yDNgNawwJDWgPtAWVA49P6E+dlkKDYv4P2sV8By0CDpcHSYLEZ8gtWiF/i600wlcdXUYNDHyUa/3HhwYMyCMIsXkX7WEw9ElqDpcHSYEVGif9qJ5HG6Y/rDQuZ9oAyoPETOqR3yIAS3DhP+7hRxfMsNFgaLA3W8/n5t5MLy+T0x3WBIZUD7QFlQOPT+hPnZZCg2L+D9rFfActgwmCxEvjpxEI6XUgJBrQTlGG7Bpr/O792DbSH9HyCIc2B9qBdA83/nR+tIZED7SM9TxnQ+G2GifppDYkcaB/IeQ1W6FE7Xgg/fhAdRc5ShnSYaRE0fw0Wf9hpDxM9SOiA1JGYA1pDIgfCIHGWMqA5tBkm6qc1JHKgfSDnNVgarF/6oYNARPh1lg5Tuwaa/0ofEr18ekeC4dPYX+eojto10Pz9gvWhhBv6SGYhUT/VYiIHwoCe1WCFzMXxQvALFp2lyEKmCwkXUb5gYY5oD9o10PwT5iKRQ1mKkXkmNbQZJnRMa0jkQHpAz2qwNFh+waJT9Hk+sQzoQgqVUrsmwZAmT3vQroHmr8HyC1ZCA4kv8u1Zwrvk5+kVUAIaLA1WQEMrCylUSu2ahXVEDUq7Bpp/QsuJHGoiDP7ARGpoM0zomNaQyIH0gJ71C5YGS4NFpyi4kOlCCpVSu2ZhodIetGug+Wuw/IKV0IBfsN7eNFgaLA1WyE4kHtbE4xgqp3JNgiFNnPagXQPNP/G4JnKgfaTnb+gjYZCon+ogkQNhQM9qsDRYGiw6RX7BChHs/5NbN/zUTR81DZZfsBIauGGW6GLTYGmwNFh0ijRYIYIarARIDVaCYl+LiT4SEomvR7SGRA6EAT2rwdJgabDoFGmwQgT7j9oNP3XTRy3x9SKRQ0xUDy9qP+5thon6aQ2JHB62P3JMg6XB0mBFRiljDuhCCpVSu2ZhodIetGug+Wuw/BVhQgM3/LBCF6EGS4OlwaJT5BesEMGMSaXJUIOiwdr4L0NQHdzQR8IgUf/ps0T4/TKY/nuwMssgIUbaTHKeDgKJ/XWWMmzXQPNP/MSX6EPzjgRDmj/VUbsGmn/i60UiB9pHev6GPhIGifqpDhI5EAb0rAbLL1h+waJT5BesEEG/YCVA0kdNg/XRhfbjnugj0VOiflpDIgfCgJ7VYGmwNFh0ijRYIYL9Ry3xFbH9KNBHLWEuEjnERPXwohv6+LD0mMGkOmj3gPD7tUsWfkV4QxPaNbTjUyEuPGwLDGkOtA90obXzT5gDypCeX2BIa6Dn1SElmPnTF5pFu480Pq1fg0UJfp6nS5EKoR0/gbFdQzt+wmTSPrR1SPPXYCUI9u9Qh7wHdJ/xDPgXaVoD1RFloMGiBDVYIYL8Jy46TAvDTHOgzWgzpPlrsBIE+3eoQ96D9i5JzCKtgeqIdkGDRQlqsEIENVh+wcpIqb1UaRX0UaHxF87THi4wpDXQPtzAgNZQ74F/g0Vl/HG+LYR2/ATFdg3t+Akd0T7QhUQZ0vwTPzUnciB3LDAk+SfOqkNOcUFH7T7S+LQLfsGiBP2CFSKoSdVgZaTUXqq0ioWHkdZAz9MeLjCkNVCGNzCgNdR74BcsKmO/YGUIarA0WBkltZcqrYI+KjT+wnnawwWGtAbahxsY0BrqPdBgURlrsDIENVgarIyS2kuVVkEfFRp/4Tzt4QJDWgPtww0MaA31HmiwqIw1WBmCGiwNVkZJ7aVKq6CPCo2/cJ72cIEhrYH24QYGtIZ6DzRYVMYarAxBDZYGK6Ok9lKlVdBHhcZfOE97uMCQ1kD7cAMDWkO9BxosKmMNVoagBkuDlVFSe6nSKuijQuMvnKc9XGBIa6B9uIEBraHeAw0WlbEGK0NQg6XByiipvVRpFfRRofEXztMeLjCkNdA+3MCA1lDvgQaLyliDlSGowdJgZZTUXqq0Cvqo0PgL52kPFxjSGmgfbmBAa6j3QINFZazByhDUYGmwMkpqL1VaBX1UaPyF87SHCwxpDbQPNzCgNdR7oMGiMtZgZQhqsDRYGSW1lyqtgj4qNP7CedrDBYa0BtqHGxjQGuo90GBRGWuwMgQ1WBqsjJLaS5VWQR8VGn/hPO3hAkNaA+3DDQxoDfUeaLCojDVYGYIaLA1WRkntpUqroI8Kjb9wnvZwgSGtgfbhBga0hnoPNFj8YX8fBNpIKiQ6jPQ8rZ/GT5gTWsPpPUz0gDJM5HB6HyjDRP00h0QfT78j0Ycmg4QGKINEDk2G/see3zRYCQEuDEJ7mGn8RB/ad9ygg9MZJnS40Md2H2j8RB9oDuR8QgOUQSIHwoCe1WBpsKiGfp1fGIT2MNP4kUaUL7lBB2WEeJYSOlzoY7sPNH6iDzQHcj6hAcogkQNhQM9qsDRYVEMarE+CdJlEGlG+ZGEhnt4HyjBRP82hLMOJ8Ik+NAtJaIAySOTQZKjB0mBF9LcwCO1hpvEjjShfcoMOygj9gtVuQCj+6fsgMcuUQSKHUDsfXaPB0mA9Es5/HloYhPYw0/iRRpQvuUEHZYQarHYDQvFP3weJWaYMEjmE2vnoGg2WBuuRcDRY/42NLpNII8qXLCzE0/tAGSbqpzmUZTgRPtGHZiEJDVAGiRyaDDVYGqyI/hYGoT3MNH6kEeVLbtBBGaFfsNoNCMU/fR8kZpkySOQQauejazRYGqxHwvELll+w/jfhLCxEutQjAwEuoQwT9dMcQPnXHE30oQkjoQHKIJFDk6EGS4MV0d/CILSHmcaPNKj4UEgAAB6HSURBVKJ8yQ06KCP0C1a7AaH4p++DxCxTBokcQu18dI0GS4P1SDh+wfILll+wIqPzX5fQR4U+au8J0Rz+Dpmzbk30oVlxQgOUQSKHJkMNlgYror+FQWgPM40faUT5kht0UEaIzU1Chwt9bPeBxk/0geZAzic0QBkkciAM6FkNlgaLaujX+YVBaA8zjR9pRPmSG3RQRohnKaHDhT62+0DjJ/pAcyDnExqgDBI5EAb0rAZLg0U1pMH6JEiXSaQR5UsWFuLpfaAME/XTHMoynAif6EOzkIQGKINEDk2GGiwNVkR/C4PQHmYaP9KI8iU36KCM0C9Y7QaE4p++DxKzTBkkcgi189E1GiwN1iPh/OehhUFoDzONH2lE+ZIbdFBGqMFqNyAU//R9kJhlyiCRQ6idj67RYGmwIr/io4P0SL3/cYgO4w01UI6UwUIPaA5thjT+DedpD6mO3xnSHNp9SDBo13B8D34OVECFQEug8RPDmMiBDMMCQ5L/DT1I1EAZUh0u6Ijm0GZI499wnvaQ6nhhFmkfEwxoDvQ81QGNT8/7BcsvWH7B+pyihYXUXiiUAc2fxl94GBM10MV++nl1xDt4gw6pDjhFdoMGS4OlwdJg/d4idCnThUjja7DYg7ByWh3xTiRmiWfBbqA6YNH5aQ2WBkuDpcHSYPFdGmMYTOXYq+jDmjAXNIc2/ASDdg3H98C/wXp7SwiRCiGRAxmG0/NPfLlo9yBRA9HA+1nKYEFHNIc2Qxr/hvO0h1THC7NI+5hgQHOg56kOaHx63i9YgUclMYztYaBCbud/Qw8SNeCF8OMHumJBRzQHBCC0T2gOp5+nPUzsI5pDuwcJBu0aju+BX7D4T+2Jh7E9DFTI7fxv6EGiBroQaR8XdERzaDOk8W84T3tIdbwwi7SPCQY0B3qe6oDGp+f9ghX6iZMKoT0Mp+efWIjtHiRqwAvBL1gUIf41K07gggsW9hHNod2GhX1GGRzfA79g+QUr8bAvDDMdxhtqoAuNMljoAc2hzZDGv+E87SHVcWIntvuQYNCugeqgnb9fsPyC9UuDVMgLw2wNfJ3QPi70gOZAKVKGNP4N52kPEz2gObT7kGDQruH4HvgFyy9YGqyPNbKwkNoLhTKg+dP4CS3TRyVRA83h9PPqiHfwBh1SHXCK7Aa/YIUeViqE9jCcnn/iYW33IFEDWwfcZC7oiObQZkjj33Ce9jAxyzSHdh8SDNo1HN8Dv2DxRyXxMLaHgQq5nf8NPUjUQBci7eOCjmgObYY0/g3naQ+pjhdmkfYxwYDmQM9THdD49LxfsPyC9UtDVMgLw2wNdB3wHzYWekBzoBQXZoHW0D5Pe5joAc2hzTDBoF3D8T3wCxZ/VG4wKFTIC8NsDXwd0j4u9IDmQClShjT+DedpDxM9oDm0+5Bg0K7h+B5osDIGiwqxLSQ6jO38Kf/Eecpwwai3+5hgSHtJGdAaaHxa//v5dg00foLBq9+R0GG7j4kaiA78FWFgmZAGfJ2tC6H8L5hMMGzfkVgmVAc0Bxqf9oDmT+Nrcj8I0j5QHdH4CR28+h20hwkd0R4kaiA5aLACy4Q0QIOVoLdxR+JRoAuB5kDj007Q/Gl8DZYGK6GhG+5I7IL2PCdqIL3UYGmwJn5iJSJeOZtYJnQh0BxofNoLmj+Nr8HSYCU0dMMdiV3QnudEDaSXGiwNlgaLTNAfZxPLhC4EmgONT1HS/Gl8DZYGK6GhG+5I7IL2PCdqIL3UYGmwNFhkgjRYIXqZhz2RDF3K9FGh8RMM2jXQ+AkGr35HQoftPiZqIDrQYGmwNFhkgjRYIXoarC+Q7UfhPQ/6MNIaaPyoKF/0MtrDhI4o+kQNJAcNVmCZkAasLFW60NpCTvSA3kEZ+usp/rDTHtqDjNGl+yAxSwktvPIdtIcarLc3DZYGyy9YoS2aeBToUqM50PgUJc2fxtdgabASGrrhjsQuaM9zogbSSw2WBkuDRSbIXxGG6GUe9kQydCnTR4XGTzBo10DjJxi8+h0JHbb7mKiB6ECDpcHSYJEJ0mCF6GmwvkC2H4XEr3ZoDe2HOSrqQy+jPUzoiKJL1EBy0GBpsDRYZII0WCF6GiwN1r+kpMGKjtWjyxLmpN3HRA2P4H0e0mBpsDRYZII0WCF6GiwNlgYrOkzwsoQ50WAlKMJG0ibQEmh8WP6v47QGmgNl0M6f1p84TxkmdEBzaPeR5p/oI2VAa6DxEwzaNdD4CQavfkdCh+0+JmogOvALll+w/IJFJsgvWCF6fsHyC5ZfsKLDBC9LmBMNVoIibCRtAi2Bxofl+wUrAXDgjoSO2lqm8WkbEgxpDpQBrYHGp/W/n2/XQOMnGLz6HQkdtvuYqIHoYOILFinAs/cQoMNIh6kdf+Fhu0FN7T7S+LQHdA4WdEgZJhjQPtDzbQY0/nv9tA80Bxof9/BnOwNageevIdAepnb8hYftBjG1+0jj0x4kVjqtgebQjk97kDjfZkDja7BG/k3uCTF6x/kE6EDfsNTbDM5Xkb/eonOwYPSdgzt0TLV4ug78FeENL8olNbSHqR1/4WG7QUrtPtL4tAf0UVvQIWWYYED7QM+3GdD4fsHyCxadAc8HCdCBpku1HX/hYQu2s3ZVu480PgVH52BBh5RhggHtAz3fZkDja7A0WHQGPB8kQAeaLtV2/IWHLdjO2lXtPtL4FBydgwUdUoYJBrQP9HybAY2vwdJg0RnwfJAAHWi6VNvxFx62YDtrV7X7SONTcHQOFnRIGSYY0D7Q820GNL4GS4NFZ8DzQQJ0oOlSbcdfeNiC7axd1e4jjU/B0TlY0CFlmGBA+0DPtxnQ+BosDRadAc8HCdCBpku1HX/hYQu2s3ZVu480PgVH52BBh5RhggHtAz3fZkDja7A0WHQGPB8kQAeaLtV2/IWHLdjO2lXtPtL4FBydgwUdUoYJBrQP9HybAY2vwdJg0RnwfJAAHWi6VNvxFx62YDtrV7X7SONTcHQOFnRIGSYY0D7Q820GNL4GS4NFZ8DzQQJ0oOlSbcdfeNiC7axd1e4jjU/B0TlY0CFlmGBA+0DPtxnQ+BosDRadAc8HCdCBpku1HX/hYQu2s3ZVu480PgVH52BBh5RhggHtAz3fZkDja7A0WHQGPB8kQAeaLtV2/IWHLdjO2lXtPtL4FBydgwUdUoYJBrQP9HybAY2vwdJg0RnwfJAAHWi6VNvxFx62YDtrV7X7SONTcHQOFnRIGSYY0D7Q820GNL4GS4NFZ8DzQQJ0oOlSbcdfeNiC7axd1e4jjU/B0TlY0CFlmGBA+0DPtxnQ+BosDRadAc8HCdCBpku1HX/hYQu2s3ZVu480PgVH52BBh5RhggHtAz3fZkDja7BGDFaikVTMnmcEblhojMAdp53Ftze1/PZ2ug4SPaQMaA6nx09sRMowkQO548fPgQqokAgAz2YIDMgoU8iL3+IsarASX7DaY5TYR3QWaA6nx09ogDJM5EDu0GARep79TeD0QbCVHwToUr+Bo1o+XweJHtJZoDmcHj+xCyjDRA7kDg0WoedZDdZlGqBL/QYcpy/1RA9O10Gih5QBzeH0+AkdUoaJHMgdGixCz7MarMs0QJf6DThOX+qJHpyug0QPKQOaw+nxEzqkDBM5kDs0WISeZzVYl2mALvUbcJy+1BM9OF0HiR5SBjSH0+MndEgZJnIgd2iwCD3ParAu0wBd6jfgOH2pJ3pwug4SPaQMaA6nx0/okDJM5EDu0GARep7VYF2mAbrUb8Bx+lJP9OB0HSR6SBnQHE6Pn9AhZZjIgdyhwSL0PKvBukwDdKnfgOP0pZ7owek6SPSQMqA5nB4/oUPKMJEDuUODReh5VoN1mQboUr8Bx+lLPdGD03WQ6CFlQHM4PX5Ch5RhIgdyhwaL0POsBusyDdClfgOO05d6ogen6yDRQ8qA5nB6/IQOKcNEDuQODRah51kN1mUaoEv9BhynL/VED07XQaKHlAHN4fT4CR1ShokcyB0aLELPsxqsyzRAl/oNOE5f6okenK6DRA8pA5rD6fETOqQMEzmQOzRYhJ5nNViXaYAu9RtwnL7UEz04XQeJHlIGNIfT4yd0SBkmciB3aLAIPc9qsC7TAF3qN+A4faknenC6DhI9pAxoDqfHT+iQMkzkQO7QYBF6ntVgXaYButRvwHH6Uk/04HQdJHpIGdAcTo+f0CFlmMiB3HGFwTq9CaSBqbPtYX6vo50DjZ/qBbmHzkKbAc0/oSPCf+FsgmG7DqpDGbQ7uBG/rQMN1oYO6lksLLR2DjR+vYlvb290obQZ0Pw1WFwDCzqmOkzoqM2BMmjnvxC/rQMN1oIKBnKgw5wQcjsHGn+gjRqswJfQhT6SHBKzSOInztJZlEGiC+ff0daBBut8DUUqWFho7Rxo/Egj4CV0obQZ0Pz9guUXrHcNJHQERxEfb88iLmDggrYONFgDIlhIgQ5zQsjtHGj8hT7SPrQZ0Pw1WJoLDdbCJtrIIbFPSCUaLELvorP0YU0IuZ0Djb8gB9qHNgOavwZLg6XBWthEGzkk9gmpRINF6F10lj6sCSG3c6DxF+RA+9BmQPPXYGmwNFgLm2gjh8Q+IZVosAi9i87ShzUh5HYONP6CHGgf2gxo/hosDZYGa2ETbeSQ2CekEg0WoXfRWfqwJoTczoHGX5AD7UObAc1fg6XB0mAtbKKNHBL7hFSiwSL0LjpLH9aEkNs50PgLcqB9aDOg+WuwNFgarIVNtJFDYp+QSjRYhN5FZ+nDmhByOwcaf0EOtA9tBjR/DZYGS4O1sIk2ckjsE1KJBovQu+gsfVgTQm7nQOMvyIH2oc2A5q/B0mBpsBY20UYOiX1CKtFgEXoXnaUPa0LI7Rxo/AU50D60GdD8NVgaLA3WwibayCGxT0glGixC76Kz9GFNCLmdA42/IAfahzYDmr8GS4OlwVrYRBs5JPYJqUSDRehddJY+rAkht3Og8RfkQPvQZkDz12BpsDRYC5toI4fEPiGVaLAIvYvO0oc1IeR2DjT+ghxoH9oMaP4aLA2WBmthE23kkNgnpBIN1tvbW/tRIQ38OkuFRBnQ+AsPY6KGRC+bd1AdNHNPzQKt4QaGlAGdJRnSDvDztIeJnZ7IgZN4foMGS4P1Sz10oSUGgebwfAw+TiZqoDm0z7d7kKi/3ccbGNI+0B7IkHaAn6c9XHlXOInnN2iwAubiOf7cSToMdKHR+IlhpDQTNdAc2uepDtr5LxjlGxjSPtJZkiHtAD9Pe5jY6YkcOInnN2iwNFh+wfqcn9OH+fka+NfJGx62dh9vYEi1RHsgQ9oBfp72UIP19qbB0mBpsDRYv7fxDQ9b4mEgz9MNDEn9ia+IMqQd4OcTc0T7mMiBk3h+gwZLg6XB0mBpsJ7v0P86SR+VYCq1q+jDKMNa634Hpj30C5ZfsCLmoj8K/A+06UJbGEbah0QNNIf2eaqDdv6Jrye0hhsYUgZ0lmRIO8DP0x5qsDRYGqzPOaQLbWEY6UpJ1EBzaJ+nOmjnr8Fa6ED/B74NCmdnkdiHdJ8kcmh2wV8R+ivCiMlMDAIdRjpIiRpoDu3z7R4k6m/38QaGtA+0BzKkHeDnaQ/9guUXrIi54FLmN9BhoAuNxk8MI6WYqIHm0D5PddDO3y9YCx3wC9ZGF1gWiX1I90kiB0aBnfYLll+wIiYzMQh0GNko8EeBxl843+5BgkFCiySPGxiS+hMmV4a0A/x8Yo5oHxM5cBLPb9BgabA0WJ/zc/owP18D/zpJF2IiB3pHu483MGz3QIa0A/x8Yo5oHxM5cBLPb9BgabA0WBqs3xuELsTnqyh3sr2Ub2BIu0F7IEPaAX6e9vA9A9rHRA6cxPMbNFgBETzHnztJhbgwCDQHSpMypPEXzrd7kGDQ7uMNDGkfaA9kSDvAz9MearD8I/fI1xsuZX4DHQa60Gj8xDBSiokaaA7t81QH7fzf47f7eAND2kfaAxnSDvDztIeJnZ7IgZN4foNfsPyCFTGZiUFoL9VEDc9HceNkuwcJCu0+3sCQ9oH2QIa0A/w87aEGyy9YEXPBpcxvoMNAFxqN7zB+aID2gSqJ9pHmT+PfwJD20POZOUpokfSiPUs0fuJrMs2h3sOf7QwCjwotgTaRDFHqbJsBjZ94GBM5pPrx9J62FilDmj+Nn9DR0959nUvUQHN49fNUhwlzQHtAa6A6pPETDGkOlAHuoQYr89MObQQ9T4W0IOSFHGgf6HnKgMZXR5Rg/2/AeAXn35CYIzoLlCKtgeZP42uw/BXhxK9l6CDeImQ60HShJPpA76AMaHzKkOZP4/sFiyrgjvNUh4mdSknSGugs0fgJhjQHygD30C9YfsFKPEoJIZ8+THQYE32gOdA+LvSQ5tBmSON7PrPT6SzQPlAd0/xpfA2WX7D8gvW5Begw0WFOmItEDnQp0vO0DzQ+ZUjzp/ETOmozpPE9r8FaMDcLOST2CZkn/zUNgT+yJw1InaVCuuFhpAxSvSD30D6Q2LcsxNMZ0h56XoO1MMsLObTfBA2WBivyFS8hZPowJnJoP06UAc2fMqT50/h+waIKuOM81WHCHFCStAY6SzR+giHNgTLAPfRvsDI/7dBG0PNUSAtCXsiB9oGepwxofHVECfpPEXKC/IbEHNFZoFXQGmj+NL4Gy7/Biny9oYOUON8eJho/8eUhkUOiF+SOxFIj8SlDmj+Nn9AR4Zd4VGh8z2d+aE5okfSiPUs0fmIWaA71HvoFKzOMZJASZ6mQFoS8kEOiF+QOyoDEvmUhns6Q9tDzmZ1OdyrtA9UxzZ/Gv2WfkD76N1j+DVbkKx4d5sSXh0QOZJgSZxNLjeRBGdL8afyEjgi/xKNC43teg5XQIZ3lhRwS+4TMkwZLg6XBIhMUPptYaiQlupBo/jS+Bot0/56zVIcJc0Bp0hroLNH4CYY0B8oA99BfEWZ+2qGNoOepkBaEvJAD7QM9TxnQ+OqIEvSP3DlBfkNijugs0CpoDTR/Gl+D5R+5R77e0EFKnG8PE42f+PKQyCHRC3JHYqmR+JQhzZ/GT+iI8Es8KjS+5zM/NCe0SHrRniUaPzELNId6D/2ClRlGMkiJs1RIC0JeyCHRC3IHZUBi37IQT2dIe+j5zE6nO5X2geqY5k/j37JPSB/9Gyz/BivyFY8Oc+LLQyIHMkwLZxNLcaEOkgPVAWXYjk/YfZ2lNdAcaA9o/IXz7R4sMDg9Bw2WBkuDdfoU/5G/DxP/GyjKkD6MNH5CzrQGmsMCA1oDPd/uAc3f8/4NVsRcLAiJDiNdaDS+X7AyKqJ9zGTRvYVqkTJsx0/QpzXQHGgPaPyF8+0eLDA4PQe/YPkFK2IyE8uALtVEDscP9I8fp5eA86c6aOuQxscA3/hXQJrDAgNaAz1PdUzje54T0GBpsDRYfI5mbvBh4uaAMqQPI42fECOtgeawwIDWQM+3e0Dz97y/IoyYiwUh0WGkC43G91eEGRXRPmay6N5CtUgZtuMn6NMaaA60BzT+wvl2DxYYnJ6DX7D8ghUxmYllQJdqIofjB9pfEb5RHbR1SOMnNEwZ0hwWGNAa6Pl2D2j+nvcLVsRcLAiJDiNdaDS+X7AyKqJ9zGTRvYVqkTJsx0/QpzXQHGgPaPyF8+0eLDA4PQe/YPkFK2IyE8uALtVEDscPtF+w/IIVEHF7luguCCCoX9HuQR3ABQlosDRYGqwLBvmrBB8m/8g9Ief2466OuY4TOvAORkCDpcHSYLEZmjrtw8QfJsqQmhMaPyFIWgPNYYEBrYGeb/eA5u95/wYrYi4WhESHkS40Gv+d4UIOC70kOVCGJPbKWapFyrAdP9EHWgPNgfaAxl843+7BAoPTc/ALVuBhXxABHUa60Gh8DVZGRbSPmSy6t1AtUobt+An6tAaaA+0Bjb9wvt2DBQan56DB0mBFvuIllgFdqokcjh9o/8jdP3IPiLg9S3QXBBDUr2j3oA7gggQ0WBosDdYFg/xVgg+Tf4OVkHP7cVfHXMcJHXgHI6DB0mBpsNgMTZ32YeIPE2VIzQmNnxAkrYHmsMCA1kDPt3tA8/e8f+QeMRcLQqLDSBcajf/OcCGHhV6SHChDEnvlLNUiZdiOn+gDrYHmQHtA4y+cb/dggcHpOfgF6/QOhvKnC81lkGnE6X04Pf8bjD7tQULJ7X2QYHBDDYlekjvaDEnuibMarATFC+6gC+nVByklgdP7cHr+GqyMktv7gOrwncINNWS6+fyWNsPnmWdOarAyHI+/hS6kVx+klABO78Pp+WuwMkpu7wOqQw3WHTrIVPH8Fg3Wc3ZXnaQLqb1Qb2nG6X04PX8NVmaS2vuA6lCDdYcOMlU8v0WD9ZzdVSfpQmov1FuacXofTs9fg5WZpPY+oDrUYN2hg0wVz2/RYD1nd9VJupDaC/WWZpzeh9Pz12BlJqm9D6gONVh36CBTxfNbNFjP2V11ki6k9kK9pRmn9+H0/DVYmUlq7wOqQw3WHTrIVPH8Fg3Wc3ZXnaQLqb1Qb2nG6X04PX8NVmaS2vuA6lCDdYcOMlU8v0WD9ZzdVSfpQmov1FuacXofTs9fg5WZpPY+oDrUYN2hg0wVz2/RYD1nd9VJupDaC/WWZpzeh9Pz12BlJqm9D6gONVh36CBTxfNbNFjP2V11ki6k9kK9pRmn9+H0/DVYmUlq7wOqQw3WHTrIVPH8Fg3Wc3ZXnaQLqb1Qb2nG6X04PX8NVmaS2vuA6lCDdYcOMlU8v0WD9ZzdVSfpQmov1FuacXofTs9fg5WZpPY+oDrUYN2hg0wVz2/RYD1nd9VJupDaC/WWZpzeh9Pz12BlJqm9D6gONVh36CBTxfNbNFjP2V11ki6k9kK9pRmn9+H0/DVYmUlq7wOqQw3WHTrIVPH8Fg3Wc3ZXnaQLqb1Qb2nG6X04PX8NVmaS2vuA6lCDdYcOMlU8v+UKg/W8fE+mCCQWKl2KNId2/FQvyD2UAYl9y1mqwxs4tHWU6MHpNdD8FxgmcmjOkwarSf+i2IlBaC+EdvwFOVAGCzW0c0jMQrsGGr+to0QPTq+B5r/AMJED1TI5r8Ei9Dz7m0BiENoLoR1/QU6UwUIN7RwSs9CugcZv6yjRg9NroPkvMEzkQLVMzmuwCD3ParD+0MDpy+C9FLqUHYm3txt0QPvY1lGiB6fXQPNfYJjIgWqZnNdgEXqe1WBpsJyC/yBw+qOQaCh93GkOiR6cXgPNf4FhIgeqJXJeg0XoeVaDpcFyCjRY/6UB+rhTUSUe5tNroPkvMEzkQLVEzmuwCD3ParA0WE6BBkuD9RemgJoLDdZfaMo/vFKD9Q+B+X//3wnQZfB+a3shtOMvaIsyWKihnUNiFto10PhtHSV6cHoNNP8FhokcqJbJeQ0WoedZv2D5Bcsp8AuWX7D+whRQc6HB+gtN+YdXarD+ITD/737B+r80QBfigrboUl6ooZ3DDTqgDNs6SvTg9Bpo/gsMEzlQLZPzGixCz7N+wfILllPgFyy/YP2FKaDmQoP1F5ryD6/UYP1DYP7f/YLlFyyn4P8jQB/GG+jSx50ySPTg9Bpo/gsMEzlQLZHzGixCz7N+wfILllPgFyy/YP2FKaDmQoP1F5ryD6/UYP1DYP7f/YLlFyynwC9Y/78G6ONOFUbNyXv802ug+S8wTORAtUTOa7AIPc/6BcsvWE6BX7D8gvUXpoCaCw3WX2jKP7xSg/UPgfl/9wuWX7CcAr9g+QXrb0+BBuv8/67nhMH620L1fglIQAISkIAEJPCdBDRY30nbWBKQgAQkIAEJvAQBDdZLtNkiJSABCUhAAhL4TgIarO+kbSwJSEACEpCABF6CgAbrJdpskRKQgAQkIAEJfCcBDdZ30jaWBCQgAQlIQAIvQUCD9RJttkgJSEACEpCABL6TgAbrO2kbSwISkIAEJCCBlyCgwXqJNlukBCQgAQlIQALfSUCD9Z20jSUBCUhAAhKQwEsQ0GC9RJstUgISkIAEJCCB7ySgwfpO2saSgAQkIAEJSOAlCGiwXqLNFikBCUhAAhKQwHcS0GB9J21jSUACEpCABCTwEgQ0WC/RZouUgAQkIAEJSOA7CWiwvpO2sSQgAQlIQAISeAkCGqyXaLNFSkACEpCABCTwnQQ0WN9J21gSkIAEJCABCbwEAQ3WS7TZIiUgAQlIQAIS+E4CGqzvpG0sCUhAAhKQgARegoAG6yXabJESkIAEJCABCXwnAQ3Wd9I2lgQkIAEJSEACL0FAg/USbbZICUhAAhKQgAS+k4AG6ztpG0sCEpCABCQggZcgoMF6iTZbpAQkIAEJSEAC30lAg/WdtI0lAQlIQAISkMBLENBgvUSbLVICEpCABCQgge8koMH6TtrGkoAEJCABCUjgJQhosF6izRYpAQlIQAISkMB3EtBgfSdtY0lAAhKQgAQk8BIENFgv0WaLlIAEJCABCUjgOwlosL6TtrEkIAEJSEACEngJAv8DsGZkuf6mey0AAAAASUVORK5CYII=" alt="收款二维码" id="qr-code-img">
            </div>
        `;

        document.body.appendChild(panel);
        document.body.appendChild(modal);
        applyStyles();
        makeDraggable(panel);
    }

    function createConfirmStatusPanel() {
        const panel = document.createElement('div');
        panel.id = 'ticket-helper-panel';
        panel.innerHTML = `
            <div id="status-display">正在初始化...</div>
            <button id="stop-loop-btn">停止循环</button>
        `;
        document.body.appendChild(panel);
        const stopBtn = document.getElementById('stop-loop-btn');
        stopBtn.addEventListener('click', () => {
            GM_setValue('isLoopingActive', false);
            stopBtn.disabled = true;
            updateStatus('循环已由用户停止。', '#d9534f');
        });
        applyStyles(true);
    }

    function createSuccessPanel() {
        const panel = document.createElement('div');
        panel.id = 'ticket-helper-panel';
        panel.innerHTML = `
            <div id="ticket-helper-header" class="success">抢票成功!</div>
            <div id="status-display">已跳转到付款页面，脚本已自动停止。请尽快付款！</div>
        `;
        document.body.appendChild(panel);
        applyStyles(true);
    }

    function makeDraggable(element) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const header = document.getElementById("ticket-helper-header");
        if (header) { header.onmousedown = dragMouseDown; }
        function dragMouseDown(e) { e.preventDefault(); pos3 = e.clientX; pos4 = e.clientY; document.onmouseup = closeDragElement; document.onmousemove = elementDrag; }
        function elementDrag(e) { e.preventDefault(); pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY; pos3 = e.clientX; pos4 = e.clientY; element.style.top = (element.offsetTop - pos2) + "px"; element.style.left = (element.offsetLeft - pos1) + "px"; }
        function closeDragElement() { document.onmouseup = null; document.onmousemove = null; }
    }

    function applyStyles(isConfirmPage = false) {
        GM_addStyle(`
            #ticket-helper-panel {
                position: fixed; top: 80px; left: 20px; background-color: #f0f8ff;
                border: 1px solid #b0c4de; border-radius: 8px; padding: 15px;
                z-index: 99999; box-shadow: 0 4px 10px rgba(0,0,0,0.1);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                width: ${isConfirmPage ? '300px' : '340px'}; color: #333;
            }
            #ticket-helper-header {
                cursor: move; background-color: #4682b4; color: white;
                padding: 10px; margin: -15px -15px 15px -15px;
                border-top-left-radius: 8px; border-top-right-radius: 8px;
                text-align: center; font-weight: bold;
            }
            #ticket-helper-header.success { background-color: #5cb85c; }
            .control-row, .control-row-center {
                display: flex; align-items: center; margin-bottom: 12px;
            }
            .control-row { justify-content: space-between; }
            .control-row-center { justify-content: center; gap: 10px; }
            .control-row label { font-size: 14px; flex-shrink: 0; margin-right: 10px; }
            #ticket-helper-panel input, #ticket-helper-panel select {
                border: 1px solid #ccc; border-radius: 4px; padding: 6px;
                width: 100%; box-sizing: border-box;
            }
            #ticket-helper-panel input:disabled, #ticket-helper-panel select:disabled { background: #eee; }
            #ticket-helper-panel button {
                background-color: #5cb85c; color: white; border: none;
                padding: 10px 15px; border-radius: 4px; cursor: pointer;
                transition: background-color 0.2s; flex-grow: 1;
            }
            #ticket-helper-panel button:hover { opacity: 0.9; }
            #ticket-helper-panel button.secondary { background-color: #f0ad4e; }
            #ticket-helper-panel button#fetch-info-btn { background-color: #0275d8; }
            #ticket-helper-panel button#stop-grabbing-btn, #ticket-helper-panel button#stop-loop-btn { background-color: #d9534f; width: 100%; }
            #ticket-helper-panel button:disabled { background-color: #cccccc; cursor: not-allowed; }
            #ticket-helper-panel button#donate-btn { background-color: #ff8c00; width: 100%; }
            #status-display {
                margin-top: 10px; padding: 8px; background-color: #e9ecef;
                border-radius: 4px; text-align: center; font-weight: bold;
            }
            #countdown-display {
                color: #dc3545; font-size: 18px; font-weight: bold;
                text-align: center; margin-top: 8px; min-height: 22px;
                font-family: 'Courier New', Courier, monospace;
            }
            hr { border: 0; border-top: 1px solid #ddd; margin: 15px 0; }

            /* Modal Styles */
            .modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0,0,0,0.6);
                z-index: 100000;
                display: flex;
                justify-content: center;
                align-items: center;
            }
            .modal-content {
                background-color: #fff;
                padding: 25px;
                border-radius: 10px;
                text-align: center;
                position: relative;
                box-shadow: 0 5px 15px rgba(0,0,0,0.3);
                width: 300px;
            }
            .modal-close {
                position: absolute;
                top: 10px;
                right: 15px;
                font-size: 28px;
                font-weight: bold;
                color: #888;
                cursor: pointer;
            }
            .modal-close:hover {
                color: #000;
            }
            #qr-code-img {
                width: 250px;
                height: 250px;
                margin: 10px auto;
                display: block;
                border: 1px solid #ddd;
            }
        `);
    }

    // --- 脚本入口 ---
    window.addEventListener('load', handlePageRouting, false);
})();
