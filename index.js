var module = (function() {
    const klaytn = require("klaytn-api");

    const _BALANCE_BOOK   = '0xc50799DE1ebeDB05733C77f1507485F633aF6f01'; // Cypress
    const _TREASURY_VIEW  = '0x0724C4aE79A21B072591C5A53debAA67fC1ff900'; // Cypress
    const _DEPOSIT_HELPER = '0x76d55Eaf804F5F2b5560522205597A660C2a6E62'; // Cypress
    const _POOL_STATUS    = '0x3424927e32A5ed6bc5b1DE5a91197845eaBF5930'; // Cypress
    const _KSP_TOKEN      = '0xC6a2Ad8cC6e4A7E08FC37cC5954be07d499E7654'; // Cypress
    const _KLAY_TOKEN     = '0x0000000000000000000000000000000000000000'; // Cypress and Baobab
    
    const _TOKEN_DECIMALS = { [ _KLAY_TOKEN.toLowerCase() ]: 18 }

    function _build_swap_graph() {
        return _get_pool_list()
            .then((pools) => {
                return _get_pool_status(pools);
            })
            .then((status) => {
                var graph = {};
    
                Object.keys(status).forEach((pool) => {
                    var [ tokenA, tokenB, amountA, amountB ] = status[pool];
    
                    if (!(tokenA in graph)) graph[tokenA] = { edges: {} };
                    if (!(tokenB in graph)) graph[tokenB] = { edges: {} };
    
                    graph[tokenA].edges[tokenB] = [ klaytn.utils.value_to_number(amountA), klaytn.utils.value_to_number(amountB) ];
                    graph[tokenB].edges[tokenA] = [ klaytn.utils.value_to_number(amountB), klaytn.utils.value_to_number(amountA) ];
                });
    
                return graph;
            });
    }
    
    function _find_swap_path(graph, from, amount, to) {
        var winnerPath = [], winningAmount = klaytn.utils.value_to_number(0);
        var queue = [ [ from.toLowerCase(), [ from.toLowerCase() ] ] ];
        var numberOfPaths = 0;
    
        while (queue.length > 0) {
            var [ token, path ] = queue.pop();
    
            if (klaytn.utils.is_same_address(token, to)) {
                var swapAmount = _get_swap_amount(graph, path, amount);
    
                if (swapAmount.gt(winningAmount)) {
                    winnerPath = path, winningAmount = swapAmount;
                }
    
                numberOfPaths++;
            } else {
                Object.keys(_get_swap_edges(graph, token) || {}).map((neighbor) => {
                    return neighbor.toLowerCase();
                }).forEach((neighbor) => {
                    if (!path.includes(neighbor)) {
                        queue.push([ neighbor, path.concat(neighbor) ]);
                    }
                });
            }
        }
    
        return [ winnerPath, winningAmount, numberOfPaths ];
    }

    function _get_swap_edges(graph, token) {
        for (var address in graph) {
            if (klaytn.utils.is_same_address(address, token)) {
                return graph[address]["edges"];
            }
        }
    }
    
    function _get_swap_balances(graph, from, to) {
        var edges = _get_swap_edges(graph, from);
    
        for (var address in edges) {
            if (klaytn.utils.is_same_address(address, to)) {
                return edges[address];
            }
        }
    }
    
    function _get_swap_amount(graph, path, amount) {
        var paths = path.map((token, i) => {
            return (i + 1 < path.length) ? [ token, path[i + 1] ] : null;
        }).slice(0, -1);
        var swapAmount = klaytn.utils.value_to_number(amount);
    
        paths.forEach(([ from, to ]) => {
            var [ fromBalance, toBalance ] = _get_swap_balances(graph, from, to);
    
            swapAmount = _calculate_swap_amount(fromBalance, toBalance, swapAmount, 0.003);
        });
    
        return swapAmount;
    }

    function _get_swap_token(pool, from) {
        return _get_pool_status([ pool ])
            .then(({ [pool]: [ tokenA, tokenB, amountA, amountB ] })=> {
                if (utils.is_same_address(from, tokenA)) {
                    return Promise.resolve([ tokenB, amountA, amountB ]);
                }
        
                if (utils.is_same_address(from, tokenB)) {
                    return Promise.resolve([ tokenA, amountB, amountA ]);
                }

                return Promise.resolve(); 
        });
    }

    function _calculate_swap_amount(fromBalance, toBalance, amount, feeRate) {
        var actualAmount = amount.times((1 - feeRate) * 1000).div(1000);
        var k = fromBalance.times(toBalance);
        var afterFromBalance = fromBalance.plus(actualAmount);
        var afterToBalance = k.div(afterFromBalance);
    
        return toBalance.minus(afterToBalance);
    }
    
    function _approve_for_deposit(account, tokens) {
        return Promise.all(tokens.map((token) => {
            return klaytn.kip7.approve(account, token, _DEPOSIT_HELPER, '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        }));
    }
    
    function _get_deposit_allowance(account, tokens) {
        return Promise.all(tokens.map((token) => {
            return klaytn.kip7.allowance(account, token, _DEPOSIT_HELPER);
        }));
    }

    function _get_pool_rewards(account, pool) {
        return _get_total_rewards(account)
            .then((rewards) => {
                for (var address in rewards) {
                    if (klaytn.utils.is_same_address(address, pool)) {
                        return rewards[address].filter(([ token, amount ]) => !amount.isZero());
                    }
                }
            })
            .then((rewards) => {
                return _get_ksp_reward(account)
                    .then((amount) => {
                        return [ [ _KSP_TOKEN, amount ] ].concat(rewards.filter(( [ token ]) => {
                            return !klaytn.utils.is_same_address(token, _KSP_TOKEN);
                        }));
                    });
            });
    }
    
    function _get_withraw_amount(pool, amount) {
        return _get_token_pair(pool)
            .then(([ tokenA, tokenB ]) => {
                return Promise.all([ tokenA, tokenB ].map((token) => {
                    if (klaytn.utils.is_same_address(token, _KLAY_TOKEN)) {
                        return klaytn.api.balance(pool);
                    } else {
                        return klaytn.kip7.balance_of(pool, token);
                    }
                }))
                .then(([ balanceA, balanceB ]) => {
                    return klaytn.kip7.total_supply(pool)
                        .then((supply) => {
                            return [ balanceA, balanceB ].map((balance) => {
                               return balance.times(amount).div(supply);
                            });
                        });
                });
        });
    }

    function _get_token_decimals(token) {
        if (token.toLowerCase() in _TOKEN_DECIMALS) {
            return Promise.resolve(_TOKEN_DECIMALS[token.toLowerCase()]);
        } else {
            return klaytn.kip7.decimals(token)
                .then((decimal) => {
                    _TOKEN_DECIMALS[token.toLowerCase()] = decimal;
    
                    return Promise.resolve(decimal);
                });
        }
    }

    function _fold_token_decimals(token, amount) {
        return _get_token_decimals(token)
            .then((decimals) => {
                if (decimals < 18) {
                    return Promise.resolve(amount.div(klaytn.utils.value_to_number(10).pow(18 - decimals)));
                } else {
                    return Promise.resolve(amount);
                }
            });
    }
    
    function _unfold_token_decimals(token, amount) {
        return _get_token_decimals(token)
            .then((decimals) => {
                if (decimals < 18) {
                    return Promise.resolve(amount.times(klaytn.utils.value_to_number(10).pow(18 - decimals)));
                } else {
                    return Promise.resolve(amount);
                }
            });
    }
    
    function _get_token_pair(pool) {
        return Promise.all([
            klaytn.api.call(pool, klaytn.abi.encode("tokenA()")),
            klaytn.api.call(pool, klaytn.abi.encode("tokenB()"))
        ])
            .then((responses) => {
                return responses.map((response) => {
                    return klaytn.abi.decode("(address)", response)[0];
                });
            });
    }

    function _get_token_balances(account, tokens) {
        var data = klaytn.abi.encode(
            "balanceOf(address,address[])", 
            [ account, tokens ]
        );

        return klaytn.api.call(_BALANCE_BOOK, data)
            .then((response) => {
                var [ balances ] = klaytn.abi.decode("(uint256[])", response);
    
                return Promise.resolve(balances);
            });
    }

    function _estimate_swap_amount_with_klay(pool, amount) {
        var data = klaytn.abi.encode(
            "estimateSwapAmount(address,address,uint256)", 
            [ pool, _KLAY_TOKEN, amount ]);
        
        return klaytn.api.call(_DEPOSIT_HELPER, data)
            .then(function(response) {
                return klaytn.abi.decode("(uint256,uint256,uint256)", response);
            });
    }

    function _estimate_swap_amount_with_kct(pool, token, amount) {
        var data = klaytn.abi.encode(
            "estimateSwapAmount(address,address,uint256)", 
            [ pool, token, amount ]
        );
        
        return klaytn.api.call(_DEPOSIT_HELPER, data)
            .then(function(response) {
                return klaytn.abi.decode("(uint256,uint256,uint256)", response);
            });
    }
    
    function _add_liquidity_with_klay(account, pool, amount, limit, inputForLiquidity, targetForLiquidity) {
        var data = klaytn.abi.encode(
            "addLiquidityWithKlay(address,uint256,uint256,uint256)", 
            [ pool, limit, inputForLiquidity, targetForLiquidity]
        );
        
        return klaytn.broadcast.call(account, _DEPOSIT_HELPER, data, amount);
    }
    
    function _add_liquidity_with_kct(account, pool, token, amount, limit, inputForLiquidity, targetForLiquidity) {
        var data = klaytn.abi.encode(
            "addLiquidityWithKCT(address,address,uint256,uint256,uint256,uint256)", 
            [ pool, token, amount, limit, inputForLiquidity, targetForLiquidity ]
        );

        return klaytn.broadcast.call(account, _DEPOSIT_HELPER, data, 0);
    }
    
    function _remove_liquidity_with_limit(account, pool, amount, minAmountA, minAmountB) {
        var data = klaytn.abi.encode(
            "removeLiquidityWithLimit(uint256,uint256,uint256)", 
            [ amount, minAmountA, minAmountB ]
        );

        return klaytn.broadcast.call(account, pool, data, 0);
    }
    
    function _exchange_klay_pos(account, amount, tokenB, amountB, path) {
        var data = klaytn.abi.encode(
            "exchangeKlayPos(address,uint256,address[])", 
            [ tokenB, amountB, path ]
        );

        return klaytn.broadcast.call(account, _KSP_TOKEN, data, amount);
    }
    
    function _exchange_kct_pos(account, tokenA, amountA, tokenB, amountB, path) {
        var data = klaytn.abi.encode(
            "exchangeKctPos(address,uint256,address,uint256,address[])", 
            [ tokenA, amountA, tokenB, amountB, path ]
        );
        
        return klaytn.broadcast.call(account, _KSP_TOKEN, data, 0);
    }
    
    function _claim_reward(account, pool) {
        var data = klaytn.abi.encode(
            "claimReward()"
        );

        return klaytn.broadcast.call(account, pool, data, 0);
    }
    
    function _get_total_rewards(account) {
        var data = klaytn.abi.encode(
            "getTotalReward(address)", 
            [ account ]
        );
        
        return klaytn.api.call(_TREASURY_VIEW, data)
            .then((response) => {
                return klaytn.abi.decode("(uint256,address[],uint256[],address[][],uint256[][])", response);
            })
            .then((response) => {
                var rewards = {};
    
                response[1].forEach((pool, i) => {
                    rewards[pool] = response[3][i].map((token, j) => {
                        return [ token, response[4][i][j * 2] ];
                    });
                });
    
                return rewards;
            });
    }

    function _get_pool_status(pools) {
        var data = klaytn.abi.encode(
            "poolStatus(address[])", 
            [ pools ]
        );

        return klaytn.api.call(_POOL_STATUS, data)
            .then((response) => {
                return klaytn.abi.decode("(address[],address[],uint256[],uint256[],uint256[])", response);
            })
            .then((response) => {
                var status = {};
    
                pools.forEach((pool, i) => {
                    status[pool] = [ 0, 1, 2, 3, 4 ].map((index) => {
                        return response[index][i];
                    });
                });
    
                return status;
            });
    }
        
    function _get_pool_shares(account, pools) {
        var data = klaytn.abi.encode(
            "poolShares(address,address[])", 
            [ account, pools ]
        );

        return klaytn.api.call(_POOL_STATUS, data)
            .then((response) => {
                return klaytn.abi.decode("(address[],address[],uint256[],uint256[])", response);
            })
            .then((response) => {
                var shares = {};
    
                pools.forEach((pool, i) => {
                    shares[pool] = [ 0, 1, 2, 3 ].map((index) => {
                        return response[index][i];
                    });
                });
    
                return shares;
            });
    }

    function _get_pool_list() {
        return fetch("https://s.klayswap.com/stat/recentPoolStatus.json")
            .then((response) => {
                if (response.ok) {
                    return response.json();
                } else {
                    return Promise.reject({ 
                        status: response.status,
                        message: response.statusText
                    });
                }
            })
            .then((response) => {
                return response["data"].map((data) => {
                    return data["exchange"];
                });
            });
    }
    
    function _get_klay_price() {
        return fetch("https://s.klayswap.com/stat/klayPrice.json")
            .then((response) => {
                if (response.ok) {
                    return response.json();
                } else {
                    return Promise.reject({ 
                        status: response.status,
                        message: response.statusText
                    });
                }
            })
            .then((response) => {
                return parseFloat(response);
            });
    }

    return {
        claim_reward: (account, pool) => {
            return _get_pool_rewards(account, pool)
                .then((rewards) => {
                    return rewards.map(([ token ]) => token);
                })
                .then((tokens) => {
                    return _get_token_balances(account, tokens)
                        .then((beforeBalances) => {
                            return _claim_reward(account, pool)
                                .then(() => {
                                    return _get_token_balances(account, tokens);
                                })
                                .then((afterBalances) => {
                                    return tokens.map((token, i) => {
                                        return [ token, afterBalances[i].minus(beforeBalances[i]) ];
                                    }).filter(([ token, amount ]) => {
                                        return !amount.isZero();
                                    });
                                });
                    });
                })
                .then((rewards) => {
                    return Promise.all(rewards.map(([ token, amount ]) => {
                        return _unfold_token_decimals(token, amount)
                            .then((amount) => {
                                return Promise.resolve([ token, amount ]);
                            })
                    }));
                });
        },
    
        deposit_with_klay: (account, pool, amount, options={}) => {
            return _estimate_swap_amount_with_klay(pool, amount)
                .then(([ maxLP, maxSwap, targetAmount ]) => {
                    var slipage = ("slipage" in options) ? options["slipage"] : 5;
                    var limit = maxLP.times(1000 - slipage).div(1000);
                    var inputForLiquidity  = maxSwap.times(997).div(1000);
                    var targetForLiquidity = targetAmount.times(997).div(1000);
            
                    return _add_liquidity_with_klay(account, pool, amount, limit, inputForLiquidity, targetForLiquidity);  
                });
        },
     
        deposit_with_kct: (account, pool, token, amount, options={}) => {
            return _estimate_swap_amount_with_kct(pool, token, amount)
                .then(([ maxLP, maxSwap, targetAmount ]) => {
                    var slipage = ("slipage" in options) ? options["slipage"] : 5;
                    var limit = maxLP.times(1000 - slipage).div(1000);
                    var inputForLiquidity  = maxSwap.times(997).div(1000);
                    var targetForLiquidity = targetAmount.times(997).div(1000);
            
                    return _add_liquidity_with_kct(account, pool, token, amount, limit, inputForLiquidity, targetForLiquidity);  
                });
        },
    
        ensure_deposit_allowance: (account, pool) => {
            return _get_token_pair(pool)
                .then((tokens) => {
                    return tokens.filter((token) => token !== KLAY_TOKEN);
                })
                .then((tokens) => {
                    return _get_deposit_allowance(account, tokens)
                        .then((amounts) => {
                            return tokens.map((token, i) => {
                                return amounts[i].isZero() ? token : undefined; // FIXME
                            }).filter((token) => token);
                        });
                })
                .then((tokens) => {
                    return _approve_for_deposit(account, tokens);
                });
        },
    
        swap_with_klay: (account, amount, to, options={}) => {
            return _build_swap_graph()
                .then((graph) => {
                    var [ path, swapAmount ] = _find_swap_path(graph, _KLAY_TOKEN, amount, to);
    
                    if (path.length > 0) {
                        return Promise.resolve([ path, swapAmount ]);
                    } else {
                        return Promise.reject("There is no path to swap.");
                    }
                })
                .then(([ path, swapAmount ]) => {
                    return _fold_token_decimals(to, swapAmount)
                        .then((swapAmount) => {
                            var slipage = ("slipage" in options) ? options["slipage"] : 5;
                            var minAmount = swapAmount.times(1000 - slipage).div(1000);
    
                            return _exchange_klay_pos(account, amount, to, minAmount, path.slice(1, -1));
                        });
                });
        },
    
        swap_with_kct: (account, from, amount, to, options={}) => {
            return _build_swap_graph()
                .then((graph) => {
                    var [ path, swapAmount ] = _find_swap_path(graph, from, amount, to);
                    
                    if (path.length > 0) {
                        return Promise.resolve([ path, swapAmount ]);
                    } else {
                        return Promise.reject("There is no path to swap.");
                    }
                })
                .then(([ path, swapAmount ]) => {
                    return Promise.all([ [ from, amount ], [ to, swapAmount ] ].map(([ token, amount ]) => {
                        return _fold_token_decimals(token, amount);
                    }))
                        .then(([ amount, swapAmount ]) => {
                            var slipage = ("slipage" in options) ? options["slipage"] : 5;
                            var minAmount = swapAmount.times(1000 - slipage).div(1000);

                            return _exchange_kct_pos(account, from, amount, to, minAmount, path.slice(1, -1));
                        });
                });
        },

        swap_with_pool: (account, pool, from, amount, options={}) => {
            return _get_swap_token(pool, from)
                .then(([ to, fromBalance, toBalance ]) => {
                    if (to) {
                        var swapAmount = _calculate_swap_amount(fromBalance, toBalance, amount, 0.003);

                        return Promise.resolve([ to, swapAmount ]);
                    } else {
                        return Promise.reject("Pool has not the token: " + from);
                    }
                })
                .then(([ to, swapAmount ]) => {
                    return Promise.all([ [ from, amount ], [ to, swapAmount ] ].map(([ token, amount ]) => {
                        return _fold_token_decimals(token, amount);
                    }))
                        .then(([ amount, swapAmount ]) => {
                            var slipage = ("slipage" in options) ? options["slipage"] : 5;
                            var minAmount = swapAmount.times(1000 - slipage).div(1000);
        
                            if (klaytn.utils.is_same_address(from, _KLAY_TOKEN)) {
                                return _exchange_klay_pos(account, amount, to, minAmount, []);
                            } else {
                                return _exchange_kct_pos(account, from, amount, to, minAmount, []);
                            }
                        });
                });
        },
    
        ensure_swap_allowance: (account, token) => {
            return klaytn.kip7.allowance(account, token, _KSP_TOKEN)
                .then((amount) => {
                    if (amount.isZero()) {
                        return klaytn.kip7.approve(account, token, _KSP_TOKEN, '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
                    } else {
                        return Promise.resolve();
                    }
                });
        },
            
        withdraw: (account, pool, amount, options={}) => {
            return _get_withraw_amount(pool, amount)
                .then(([ amountA, amountB ]) => {
                    return [ amountA, amountB ].map((amount) => {
                        var slipage = ("slipage" in options) ? options["slipage"] : 10;
                        var minAmount = amount.times(1000 - slipage).div(1000);

                        return minAmount;
                    });
                })
                .then(([ minAmountA, minAmountB ]) => {
                    return _remove_liquidity_with_limit(account, pool, amount, minAmountA, minAmountB);
                })
        },

        get_swap_amount_with_klay: (amount, to, options={}) => {
            return _build_swap_graph()
                .then((graph) => {
                    var [ path, swapAmount, numberOfPaths ] = _find_swap_path(graph, _KLAY_TOKEN, amount, to);
    
                    if (path.length > 0) {
                        return Promise.resolve([ path, swapAmount, numberOfPaths ]);
                    } else {
                        return Promise.reject("There is no path to swap.");
                    }
                })
                .then(([ path, swapAmount, numberOfPaths ]) => {
                    var slipage = ("slipage" in options) ? options["slipage"] : 0;
                    var minAmount = swapAmount.times(1000 - slipage).div(1000);

                    return [ path, minAmount, numberOfPaths ];
                });
        },
    
        get_swap_amount_with_kct: (from, amount, to, options={}) => {
            return _build_swap_graph()
                .then((graph) => {
                    var [ path, swapAmount, numberOfPaths ] = _find_swap_path(graph, from, amount, to);
            
                    if (path.length > 0) {
                        return Promise.resolve([ path, swapAmount, numberOfPaths ]);
                    } else {
                        return Promise.reject("There is no path to swap.");
                    }
                })
                .then(([ path, swapAmount, numberOfPaths ]) => {
                    var slipage = ("slipage" in options) ? options["slipage"] : 0;
                    var minAmount = swapAmount.times(1000 - slipage).div(1000);
                    
                    return [ path, minAmount, numberOfPaths ];
                });
        },

        get_swap_amount_with_pool: (pool, from, amount, options={}) => {
            return _get_swap_token(pool, from)
                .then(([ to, fromBalance, toBalance ]) => {
                    if (to) {
                        var swapAmount = _calculate_swap_amount(fromBalance, toBalance, amount, 0.003);

                        return Promise.resolve([ to, swapAmount ]);
                    } else {
                        return Promise.reject("Pool has not the token: " + from);
                    }
                })
                .then(([ to, swapAmount ]) => {
                    var slipage = ("slipage" in options) ? options["slipage"] : 0;
                    var minAmount = swapAmount.times(1000 - slipage).div(1000);
                            
                    return minAmount;
                });
        },

        get_withraw_amount: (pool, amount, options={}) => {
            return _get_withraw_amount(pool, amount)
                .then(([ amountA, amountB ]) => {
                    return [ amountA, amountB ].map((amount) => {
                        var slipage = ("slipage" in options) ? options["slipage"] : 0;
                        var minAmount = amount.times(1000 - slipage).div(1000);

                        return minAmount;
                    });
                });
        },
    
        get_token_pair: (pool) => {
            return _get_token_pair(pool);
        }, 

        get_token_balances: (account, tokens) => {
            return _get_token_balances(account, tokens);
        },

        get_token_shares: (account) => {
            return _get_pool_list()
                .then((pools) => {
                    return _get_pool_shares(account, pools);
                });
        },

        get_token_prices: (tokens) => {
            return _build_swap_graph()
                .then((graph) => {
                    return Promise.resolve(tokens.map((token) => {
                        var [ path, swapAmount ] = _find_swap_path(graph, token, klaytn.utils.value_to_peb(1, "KLAY"), _KLAY_TOKEN);
    
                        return [ token, klaytn.utils.peb_to_number(swapAmount, "KLAY") ];
                    }));
                })
                .then((tokens) => {
                    return _get_klay_price()
                        .then((klayPrice) => {
                            var prices = {};
    
                            tokens.forEach(([ token, amount ]) => {
                                prices[token] = klayPrice * amount;
                            });
    
                            return Promise.resolve(prices);
                        })
                });
        },

        cache_token_decimals: (token, decimals) => {
            _TOKEN_DECIMALS[token.toLowerCase()] = decimals;
        }
    }
})();

__MODULE__ = module;
