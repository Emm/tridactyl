import * as Perf from "@src/perf"
import { browserBg } from "@src/lib/webext.ts"
import { enumerate } from "@src/lib/itertools"
import * as Containers from "@src/lib/containers"
import * as Messaging from "@src/lib/messaging"
import * as Completions from "@src/completions"

class BufferCompletionOption extends Completions.CompletionOptionHTML
    implements Completions.CompletionOptionFuse {
    public fuseKeys = []

    constructor(
        public value: string,
        tab: browser.tabs.Tab,
        public isAlternative = false,
        container: browser.contextualIdentities.ContextualIdentity,
    ) {
        super()
        // Two character tab properties prefix
        let pre = ""
        if (tab.active) pre += "%"
        else if (isAlternative) {
            pre += "#"
            this.value = "#"
        }
        if (tab.pinned) pre += "@"

        // Push prefix before padding so we don't match on whitespace
        this.fuseKeys.push(pre)

        // Push properties we want to fuzmatch on
        this.fuseKeys.push(String(tab.index + 1), tab.title, tab.url)

        // Create HTMLElement
        const favIconUrl = tab.favIconUrl
            ? tab.favIconUrl
            : Completions.DEFAULT_FAVICON
        this.html = html`<tr class="BufferCompletionOption option container_${container.color} container_${container.icon} container_${container.name}"
            >
                <td class="prefix">${pre.padEnd(2)}</td>
                <td class="container"></td>
                <td class="icon"><img src="${favIconUrl}" /></td>
                <td class="title">${tab.index + 1}: ${tab.title}</td>
                <td class="content">
                    <a class="url" target="_blank" href=${tab.url}
                        >${tab.url}</a
                    >
                </td>
            </tr>`
    }
}

export class BufferCompletionSource extends Completions.CompletionSourceFuse {
    public options: BufferCompletionOption[]
    private shouldSetStateFromScore = true

    // TODO:
    //     - store the exstr and trigger redraws on user or data input without
    //       callback faffery
    //     - sort out the element redrawing.

    constructor(private _parent) {
        super(
            ["tab", "tabclose", "tabdetach", "tabduplicate", "tabmove"],
            "BufferCompletionSource",
            "Tabs",
        )

        this.updateOptions()
        this._parent.appendChild(this.node)
    }

    async onInput(exstr) {
        // Schedule an update, if you like. Not very useful for tabs, but
        // will be for other things.
        return this.updateOptions(exstr)
    }

    async filter(exstr) {
        this.lastExstr = exstr
        return this.onInput(exstr)
    }

    setStateFromScore(scoredOpts: Completions.ScoredOption[]) {
        super.setStateFromScore(scoredOpts, this.shouldSetStateFromScore)
    }

    /** Score with fuse unless query is a single # or looks like a tab index */
    scoredOptions(
        query: string,
        options = this.options,
    ): Completions.ScoredOption[] {
        const args = query.trim().split(/\s+/gu)
        if (args.length === 1) {
            // if query is an integer n and |n| < options.length
            if (Number.isInteger(Number(args[0]))) {
                let index = Number(args[0]) - 1
                if (Math.abs(index) < options.length) {
                    index = index.mod(options.length)
                    return [
                        {
                            index,
                            option: options[index],
                            score: 0,
                        },
                    ]
                }
            } else if (args[0] === "#") {
                for (const [index, option] of enumerate(options)) {
                    if (option.isAlternative) {
                        return [
                            {
                                index,
                                option,
                                score: 0,
                            },
                        ]
                    }
                }
            }
        }

        // If not yet returned...
        return super.scoredOptions(query, options)
    }

    @Perf.measuredAsync
    private async updateOptions(exstr = "") {
        this.lastExstr = exstr
        let [prefix, query] = this.splitOnPrefix(exstr)

        // Hide self and stop if prefixes don't match
        if (prefix) {
            // Show self if prefix and currently hidden
            if (this.state === "hidden") {
                this.state = "normal"
            }
        } else {
            this.state = "hidden"
            return
        }

        // When the user is asking for tabmove completions, don't autoselect if the query looks like a relative move https://github.com/tridactyl/tridactyl/issues/825
        this.shouldSetStateFromScore = !(
            prefix == "tabmove " && query.match("^[+-][0-9]+$")
        )

        /* console.log('updateOptions', this.optionContainer) */
        const tabs: browser.tabs.Tab[] = await browserBg.tabs.query({
            currentWindow: true,
        })
        const options = []
        // Get alternative tab, defined as last accessed tab.
        tabs.sort((a, b) => (b.lastAccessed - a.lastAccessed))
        const alt = tabs[1]
        tabs.sort((a, b) => (a.index - b.index))

        for (const tab of tabs) {
            options.push(
                new BufferCompletionOption(
                    (tab.index + 1).toString(),
                    tab,
                    tab === alt,
                    await Containers.getFromId(tab.cookieStoreId),
                ),
            )
        }

        this.completion = undefined
        this.options = options
        if (query && query.trim().length > 0) {
            this.setStateFromScore(this.scoredOptions(query))
        } else {
            this.options.forEach(option => (option.state = "normal"))
        }
        return this.updateDisplay()
    }
}
