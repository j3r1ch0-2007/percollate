#!/usr/bin/env node
const pup = require('puppeteer');
const got = require('got');
const ora = require('ora');
const { JSDOM } = require('jsdom');
const nunjucks = require('nunjucks');
const tmp = require('tmp');
const fs = require('fs');
const css = require('css');
const slugify = require('slugify');
const Readability = require('./vendor/readability');
const pkg = require('./package.json');
var Epub = require('epub-gen');

const spinner = ora();

let cmd = 'pdf'; // default command

const {
	imagesAtFullSize,
	wikipediaSpecific,
	noUselessHref,
	relativeToAbsoluteURIs,
	singleImgToFigure
} = require('./src/enhancements');
const get_style_attribute_value = require('./src/get-style-attribute-value');

const resolve = path =>
	require.resolve(path, {
		paths: [process.cwd(), __dirname]
	});

const enhancePage = function(dom) {
	[
		relativeToAbsoluteURIs,
		imagesAtFullSize,
		singleImgToFigure,
		noUselessHref,
		wikipediaSpecific
	].forEach(enhancement => {
		enhancement(dom.window.document);
	});
};

function createDom({ url, content }) {
	const dom = new JSDOM(content, { url });

	// Force relative URL resolution
	dom.window.document.body.setAttribute(null, null);

	return dom;
}

/*
	Some setup
	----------
 */
function configure() {
	nunjucks.configure({ autoescape: false, noCache: true });
}

/*
	Fetch a web page and clean the HTML
	-----------------------------------
 */
async function cleanup(url) {
	try {
		spinner.start(`Fetching: ${url}`);
		const content = (await got(url, {
			headers: {
				'user-agent': `percollate/${pkg.version}`
			}
		})).body;
		spinner.succeed();

		spinner.start('Enhancing web page');
		const dom = createDom({ url, content });

		/* 
			Run enhancements
			----------------
		*/
		enhancePage(dom);

		// Run through readability and return
		const parsed = new Readability(dom.window.document, {
			classesToPreserve: [
				'no-href',

				/*
					Placed on some <a> elements
					as in-page anchors
				 */
				'anchor'
			]
		}).parse();

		spinner.succeed();

		return { ...parsed, url };
	} catch (error) {
		spinner.fail(error.message);
		throw error;
	}
}

/*
	Bundle the HTML files into a PDF
	--------------------------------
 */
async function bundle(items, options) {
	spinner.start('Generating temporary HTML file');
	const temp_file = tmp.tmpNameSync({ postfix: '.html' });

	// let stylesheet;
	// if(options == null){
	// 	stylesheet = resolve('./templates/default.css');
	// } else {
	// 	stylesheet = resolve(options.style);
	// }
	const stylesheet = resolve(options.style || './templates/default.css');
	const style = fs.readFileSync(stylesheet, 'utf8') + (options.css || '');

	const html = nunjucks.renderString(
		fs.readFileSync(
			resolve(options.template || './templates/default.html'),
			'utf8'
		),
		{
			items,
			style,
			stylesheet // deprecated
		}
	);

	const doc = new JSDOM(html).window.document;
	const headerTemplate = doc.querySelector('.header-template');
	const footerTemplate = doc.querySelector('.footer-template');
	const header = new JSDOM(
		headerTemplate ? headerTemplate.innerHTML : '<span></span>'
	).window.document;
	const footer = new JSDOM(
		footerTemplate ? footerTemplate.innerHTML : '<span></span>'
	).window.document;

	const css_ast = css.parse(style);

	const header_style = get_style_attribute_value(css_ast, '.header-template');
	const header_div = header.querySelector('body :first-child');

	if (header_div && header_style) {
		header_div.setAttribute(
			'style',
			`
				${header_style};
				${header_div.getAttribute('style') || ''}
			`
		);
	}

	const footer_style = get_style_attribute_value(css_ast, '.footer-template');
	const footer_div = footer.querySelector('body :first-child');

	if (footer_div && footer_style) {
		footer_div.setAttribute(
			'style',
			`
				${footer_style};
				${footer_div.getAttribute('style') || ''}
			`
		);
	}

	fs.writeFileSync(temp_file, html);

	spinner.succeed(`Temporary HTML file: file://${temp_file}`);

	spinner.start(`Staging temporary HTML file: file://${temp_file}`);
	const browser = await pup.launch({
		headless: true,
		/*
			Allow running with no sandbox
			See: https://github.com/danburzo/percollate/issues/26
		 */
		args: options.sandbox
			? undefined
			: ['--no-sandbox', '--disable-setuid-sandbox'],
		defaultViewport: {
			// Emulate retina display (@2x)...
			deviceScaleFactor: 2,
			// ...but then we need to provide the other
			// viewport parameters as well
			width: 1920,
			height: 1080
		}
	});
	const page = await browser.newPage();
	await page.goto(`file://${temp_file}`, { waitUntil: 'load' });

	spinner.succeed(`Loaded temporary HTML file: file://${temp_file}`);

	spinner.start(`Setting output file name.`);

	/*
		When no output path is present,
		produce the file name from the web page title
		(if a single page was sent as argument),
		or a timestamped file (for the moment)
		in case we're bundling many web pages.
	 */
	const output_path =
		options.output ||
		(items.length === 1
			? `${slugify(items[0].title || 'Untitled page')}.${cmd}`
			: `percollate-${Date.now()}.${cmd}`);
	spinner.succeed(`Set output file name to: ${output_path}`);

	// TODO At this point the command needs to be evaluate and another framework launched to create epub files
	if (cmd === 'pdf') {
		spinner.start('Saving PDF');

		// const browser = await pup.launch({
		// 	headless: true,
		// 	/*
		// 		Allow running with no sandbox
		// 		See: https://github.com/danburzo/percollate/issues/26
		// 	 */
		// 	args: options.sandbox
		// 		? undefined
		// 		: ['--no-sandbox', '--disable-setuid-sandbox'],
		// 	defaultViewport: {
		// 		// Emulate retina display (@2x)...
		// 		deviceScaleFactor: 2,
		// 		// ...but then we need to provide the other
		// 		// viewport parameters as well
		// 		width: 1920,
		// 		height: 1080
		// 	}
		// });
		// const page = await browser.newPage();
		// await page.goto(`file://${temp_file}`, { waitUntil: 'load' });

		await page.pdf({
			path: output_path,
			preferCSSPageSize: true,
			displayHeaderFooter: true,
			headerTemplate: header.body.innerHTML,
			footerTemplate: footer.body.innerHTML,
			printBackground: true
		});

		spinner.succeed(`Saved PDF: ${output_path}`);
	} else if (cmd === 'epub') {
		spinner.start('Saving EPUB');

		let bodyHTML = await page.evaluate(() => document.body.innerHTML);

		let option = {
			title: items[0].title,
			content: [
				{
					data: bodyHTML
				}
			]
		};

		new Epub(option, output_path);

		spinner.succeed(`Saved EPUB: ${output_path}`);
	} else if (cmd === 'html') {
		// spinner.succeed('HTML command not implemented yet.');
		spinner.start('Saving HTML');

		let bodyHTML = await page.evaluate(() => document.body.innerHTML);

		fs.writeFile(output_path, bodyHTML, function(err) {
			if (err) {
				return console.log(err);
			}
		});

		spinner.succeed(`Saved HTML: ${output_path}`);
	}

	spinner.start('Closing staging browser.');
	await browser.close();
	spinner.succeed('Staging browser closed.');
	spinner.succeed('All done.');
}

async function generateOutput(urls, options) {
	if (!urls.length) return;
	let items = [];
	for (let url of urls) {
		let item = await cleanup(url);
		if (options.individual) {
			await bundle([item], options);
		} else {
			items.push(item);
		}
	}
	if (!options.individual) {
		await bundle(items, options);
	}
}

/*
	Generate PDF
 */
async function pdf(urls, options) {
	cmd = 'pdf';
	console.log('Generating PDF output');
	await generateOutput(urls, options);
	// if (!urls.length) return;
	// let items = [];
	// for (let url of urls) {
	// 	let item = await cleanup(url);
	// 	if (options.individual) {
	// 		await bundle([item], options);
	// 	} else {
	// 		items.push(item);
	// 	}
	// }
	// if (!options.individual) {
	// 	await bundle(items, options);
	// }
}

/*
	Generate EPUB
 */
async function epub(urls, options) {
	// console.log('TODO', urls, options);
	cmd = 'epub';
	console.log('Generating EPUB output');
	await generateOutput(urls, options);
}

/*
	Generate HTML
 */
async function html(urls, options) {
	// console.log('TODO', urls, options);
	cmd = 'html';
	console.log('Generating HTML output');
	await generateOutput(urls, options);
}

module.exports = { configure, pdf, epub, html };
