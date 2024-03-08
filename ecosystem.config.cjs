module.exports = {
	apps: [
		{
			name: "inspect",
			exec_mode: "cluster",
			instances: 5,
			script: "index.js",
			combine_logs: true,
			time: true,
			node_args: ["--max_old_space_size=2000"],
		},
	],
};
