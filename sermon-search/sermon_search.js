if (displayedCount < sermonsToDisplay.length) {
            loadingDiv.classList.remove('hidden');
        } else {
            loadingDiv.classList.add('hidden');
        }
    }

    // ===================== SORT FUNCTION (Add if missing) =====================
    function sortSermons(list, sortMode) {
        const sorted = [...list];
        // Add your sorting logic here if not already present
        return sorted;
    }

    // ===================== SETUP SORT CONTROLS (Your Original) =====================
    function setupSortControls() {
        const container = document.querySelector('.max-w-4xl.mx-auto');
        if (!container) return;

        const sortDiv = document.createElement('div');
        sortDiv.className = 'mb-8';
        sortDiv.innerHTML = 
            <label for="sortSelect" class="mr-2">Sort by:</label>
            <select id="sortSelect" class="border p-2 rounded">
                <option value="id-desc">ID (Newest First)</option>
                <option value="id-asc">ID (Oldest First)</option>
                <option value="title-asc">Title (A-Z)</option>
                <option value="title-desc">Title (Z-A)</option>
                <option value="speaker-asc">Speaker (A-Z)</option>
                <option value="speaker-desc">Speaker (Z-A)</option>
                <option value="date-desc">Date (Newest First)</option>
                <option value="date-asc">Date (Oldest First)</option>
            </select>
        ;
        container.insertBefore(sortDiv, resultsDiv);

        const sortSelect = document.getElementById('sortSelect');
        sortSelect.addEventListener('change', function() {
            currentSort = sortSelect.value;
            const query = searchInput.value.trim();
            let results = query ? fuse.search(query).map(result => result.item) : sermons;
            displayResults(sortSermons(results, currentSort));
        });
    }

    // ===================== INFINITE SCROLL (Your Original) =====================
    function handleScroll() {
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 100) {
            const query = searchInput.value.trim();
            let results = query ? fuse.search(query).map(result => result.item) : sermons;
            displayResults(sortSermons(results, currentSort), true);
        }
    }

    // ===================== DEBOUNCED SEARCH (UPDATED WITH SEMANTIC) =====================
    const debouncedSearch = debounce(async function() {
        const query = searchInput.value.trim();
        loadingDiv.classList.remove('hidden');

        let results = [];

        if (query.length > 2) {
            // === NEW: Try Semantic Search First ===
            results = await semanticSearch(query);
            
            // Fallback to Fuse.js if semantic gives poor results
            if (results.length < 5) {
                results = fuse.search(query).map(result => result.item);
            }
        } else {
            results = sermons;
        }

        displayResults(sortSermons(results, currentSort));
        loadingDiv.classList.add('hidden');
    }, 300);

    // ===================== DEBOUNCE HELPER =====================
    function debounce(func, delay) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), delay);
        };
    }

    // ===================== EVENT LISTENERS =====================
    searchInput.addEventListener('input', debouncedSearch);
    window.addEventListener('scroll', debounce(handleScroll, 100));

});