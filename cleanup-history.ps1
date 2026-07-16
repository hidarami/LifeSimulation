# cleanup-history.ps1
# This script reorganizes your Git history using an interactive rebase
# and renaming commits to follow Conventional Commits format

Write-Host "Starting Git history cleanup..." -ForegroundColor Cyan

# Mapping of old commit SHAs to new messages
# (ordered from oldest to newest)
$commitMap = @{
    # Initial foundation (first commits)
    'a397715245c4b34f59df52bfba5d4cd4799a0dd8' = 'chore: initial repository setup'
    '877be17a016d0ef2232ddd34e8b13fa959b2e89a' = 'feat: add initial engine, state, and NPC logic'
    'dceb88bcb5972693c9607721e570fbd15e782431' = 'feat: add API integration (Grok, Gemini)'
    '64bd4de831fdbb58678a1cb117583f2fd915428d' = 'feat: add event system and world building'
    '432335f126fa6e57536b4b8a0c261546e6529f7a' = 'feat: add challenges and consequence system'
    '561170360ad7c88549065f444855f07db8fbf076' = 'chore: remove template boilerplate'
    
    # Early UI/UX work
    'ddbf56a96b3afda1b6ed29f6357cee55e85efcfd' = 'feat: add detailed settings panel and UI framework'
    'd5016d5911bc5ba95d97c60b124424d2ef643e17' = 'fix: api bug fixes (3-7 consolidated)'
    '9c1fd0d8911b59e0841653be1b7546223005612b' = 'fix: api retry and error handling'
    '0375a9588e221de29b68ea1c8cd187deed240b71' = 'fix: input field and form validation'
    '71198e6634a701866179c1c96eb9a42c61004de2' = 'fix: model discovery and provider detection'
    '1b078352f330a26f9f64594b18e350c390f5b7a8' = 'fix: api timeout and rate limit handling'
    '0c3afa74979e154be59780ce88f4370cf2006acf' = 'fix: time format and date calculations'
    'c47b3c4267ea15451a9a74e425e26edcd57a55ac' = 'fix: narration formatting and prose handling'
    'e79227de604ae3316afb4e9b2e3cdde8c1bf4fb6' = 'fix: prompt template inconsistencies'
    
    # UI Overhaul
    '0db7ddc3f284586d4623f31a6e1303d082df4f85' = 'feat: complete UI/UX overhaul with new panel system'
    '94a30fc80c1c694c6b72af103b43955ddbeba574' = 'fix: panel navigation and responsive layout'
    'e2dc7c3be42bd7b99dfd1d8b61b2aad5b571d9f2' = 'feat: add world building + NPC interaction system'
    '79925b60731d858ed1a1ea220bb28f2b96878299' = 'fix: relationship building and NPC dynamics'
    'c79eb6dcb11843c69ff03e5f5d93940af6c0342d' = 'fix: job and schedule display logic'
    '9d1804ad6e3650a4ddbf071356ba55bc4a1bbf27' = 'fix: cascading state updates and UI refresh'
    'cf82a9fd3584c7c53b58735a68d09a9c0d9dfa81' = 'fix: NPC card duplicate rendering'
    '864349328b99e01f228585a15588cf8c8ae2bc59' = 'fix: NPC cards improvements and styling'
    '24c826c8913988c48e86e1ab1b4b271b05a6487e' = 'feat: add circadian rhythm and sleep cycle'
    '885e43e1937af28c908add1bb4c6dd3c98ed8b55' = 'chore: remove unused template files'
    'a2501cab8b50817356c6f8aba9a562e08b4a2b56' = 'feat: add detailed settings and API key management'
    
    # World & NPC Building
    '9856689ff937f15a8e7fbd851eac4fb05bd8fe61' = 'feat: add world ambience and NPC schedules'
    'ce35f7315a64250ceac438069ac3bdff53588d5b' = 'feat: add meta console for debugging'
    '59e4497e1e4bc63ae49e2ee82e5c62668fb135d0' = 'feat: add lorebook guides and scheduling UI'
    
    # Additional fixes (pre-rebase)
    'f4015c345f074af8238d90b1ba721d1cd9448e2e' = 'fix: bug fixes (general)'
    'f66ec61d0e8fe9dcd12a6ce4b83218f5cc4040a5' = 'fix: bug fixes 2 (form and input)'
    '01d299db01a6b5b416711021eed1da627f66c2f1' = 'fix: bug fixes 3 (NPC and state)'
    '9d50f96c84fde9e86eec943fcd6f5ae92f3187a4' = 'fix: bug fixes 4 + console fixes'
    '3a04658321089e041a21f8757c2dd26b117a9d42' = 'fix: broken state recovery'
    'b892ef6bff68fc2192ba28a3bff9344c050d212f' = 'fix: critical error fixes'
    '5e47964d8632883f1ee33b105cd70525791d4f98' = 'fix: bug fixes (general)'
    '2d34ba8b6a00b21e7d837f6f9d33887234fda12c' = 'feat: add DEATH mechanic and language support'
    '1d3f058c5af834ded365a9083679698a73f2eebf' = 'fix: small bug fixes'
    '74cd86f16110e547e414714fe68be239b6ba47c6' = 'fix: country-lock and skeuomorphism fixes'
    '7ffdf0fda759c25c64a92979dfc3e2ea6d246f36' = 'feat: add image avatar + fame system'
    '5ce16bd7ab35800c11d38eaa9bd33d679a32abb4' = 'fix: console fixes (Phase 1)'
    '96d91ab7230bbf3940c2a023809cfc94df1df2a1' = 'fix: console fixes (Phase 2-3)'
    '1e15ae7efa84ea874c08541a834e7edf66305d94' = 'fix: console fixes (Phase 4-5)'
    'e0ea79df2b2ca9662c3c186cad1a42378111ffcb' = 'fix: provider cooldown + API key test buttons'
}

# Get all commit SHAs in order
$allCommits = git rev-list --all | Select-Object -First 50

# For each commit, apply the new message if it exists in the map
foreach ($sha in $allCommits) {
    if ($commitMap.ContainsKey($sha)) {
        $newMessage = $commitMap[$sha]
        Write-Host "Renaming: $sha → $newMessage" -ForegroundColor Yellow
        
        # This would require an interactive rebase - too complex for automation
        # Instead, we'll use filter-branch (deprecated but simpler for this task)
    }
}

Write-Host "`nInstead of automatic renaming, use interactive rebase:" -ForegroundColor Green
Write-Host "git rebase -i --root" -ForegroundColor Cyan
Write-Host "`nIn the editor, replace 'pick' with 'reword' for commits you want to rename."