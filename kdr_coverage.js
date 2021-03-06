'use-strict';

// monkey-patch dat.GUI

dat.GUI.prototype.removeFolder = function (fldl) {
	var name = fldl.name;
	var folder = this.__folders[name];
	if (!folder) {
		return;
	}
	folder.close();
	this.__ul.removeChild(folder.domElement.parentNode);
	delete this.__folders[name];
	this.onResize();
}

// global variables

var container, stats

var camera, controls, scene, renderer;
var gui;
var startTime = Date.now();
var arms = [];
var armGuiFolders = [];
var baseArm = null;
var spheres = [];
var particles = null;
var coverageDirtyPos = true;
var coverageDirtyCount = true;
var coverageDirtyTransparency = false;
var coveragePositions = [];

// some constants
const epsilon = 1e-6;
const coverageParticleSize = 0.5;
const maxPrecision = 32;
const maxBasePrecision = 64;

var params = {
	coverage: false,
	coverageType: 'particles',
	coverageTransparent: false,
	coverageDiscrete: false,
	coveragePrecision: 8,
	coverageScale: 0.5,
	basePrecision: 0,
	armCount: 3,
	robotScale: 1,
	robotColor: '#dd4411',
	coverageColor: '#ff0000'
};

var currentParams = {
	armCount: 0,
	coverageType: '',
	minDim: 0
};

var RobotArm = function(armLen, createMesh = true) {
	THREE.Object3D.apply(this, arguments);
	if (createMesh) {
		var armGeometry = new THREE.CubeGeometry(0.25, 1, 0.25);
		this.armMesh = new THREE.Mesh(armGeometry, this.armMaterial);
		this.armMesh.scale.x = params.robotScale;
		this.armMesh.scale.y = armLen;
		this.armMesh.scale.z = params.robotScale;
		this.armMesh.position.y = armLen / 2;
		this.add(this.armMesh);
	}
	this.armLen = armLen;
	this.childArm = null;
	this.constraint = {
		min: -Math.PI / 2,
		max: Math.PI / 2
	}

	this.addArm = function addArm(childArm) {
		childArm.position.y = this.armLen;
		this.childArm = childArm;
		this.add(childArm);
	}

	this.cloneArm = function cloneArm() {
		var base = new RobotArm(this.armLen, false);
		base.rotation = this.rotation;
		base.constraint = this.constraint;
		if (this.childArm) {
			base.addArm(this.childArm.cloneArm());
		}
		return base;
	}

	this.getLastChild = function getLastChild() {
		if (this.childArm) {
			var desc = this.childArm;
			while(desc.childArm) {
				desc = desc.childArm;
			}
			return desc;
		} else {
			return this;
		}
	}

	this.updateArmLength = function updateArmLength() {
		if (this.childArm) {
			this.childArm.position.y = this.armLen;
		}
		if (this.armMesh) {
			this.armMesh.scale.y = this.armLen;
			this.armMesh.position.y = this.armLen / 2;
		}
	}

	this.updateConstraints = function updateConstraints(vertical) {
		if (vertical) {
			this.rotation.y = Math.min(Math.max(this.rotation.y, this.constraint.min), this.constraint.max);
		} else {
			this.rotation.x = Math.min(Math.max(this.rotation.x, this.constraint.min), this.constraint.max);
		}
	}

	this.getCombinedArmLength = function getCombinedArmLength() {
		if (!this.childArm) {
			return this.armLen;
		} else {
			return this.armLen + this.childArm.getCombinedArmLength();
		}
	}
}
RobotArm.prototype = Object.create(THREE.Object3D.prototype);
RobotArm.prototype.constructor = RobotArm;
RobotArm.prototype.armMaterial = new THREE.MeshLambertMaterial();
RobotArm.prototype.armMaterial.color = new THREE.Color(parseInt(params.robotColor.replace('#', '0x')));

function changeRobotColor() {
	RobotArm.prototype.armMaterial.color = new THREE.Color(parseInt(params.robotColor.replace('#', '0x')));
}

function changeRobotScale() {
	baseArm.armMesh.scale.x = params.robotScale;
	baseArm.armMesh.scale.z = params.robotScale;
	var descending = baseArm.childArm;
	while(descending) {
		descending.armMesh.scale.x = params.robotScale;
		descending.armMesh.scale.z = params.robotScale;
		descending = descending.childArm;
	}
}

var Octree = function Octree(center, halfDim, minDim) {
	this.c = center;
	this.halfDim = halfDim;
	this.minDim = minDim;

	this.points = [];

	this.subtrees = []; // will hold references to subtrees
	for (var i = 0; i < 8; ++i) {
		this.subtrees.push(null);
	}

	this.addPoint = function(p) {
		if (this.halfDim < this.minDim) {
			this.points.push(p);
		} else {
			// put in a subtree
			var subTree = this.getSubtree(p, true);
			subTree.addPoint(p);
		}
	}

	this.containsPoints = function(p) {
		if (this.halfDim < this.minDim) {
			return this.points.length;
		} else {
			var subTree = this.getSubtree(p, false);
			return (null != subTree ? subTree.containsPoints(p) : 0);
		}
	}

	this.getCentersWithPoint = function(a) {
		if (this.halfDim < this.minDim) {
			if (this.points.length > 0) {
				a.push(this.c);
			}
		} else {
			this.subtrees.forEach(function(subtree) {
				if (subtree) {
					subtree.getCentersWithPoint(a);
				}
			});
		}
	}

	this.getSubtree = function(p, create) {
		var subtreeIndex =
			(p.y < this.c.y ? 4 : 0) +
			(p.x < this.c.x ? 2 : 0) +
			(p.z < this.c.z ? 1 : 0);
		if (null == this.subtrees[subtreeIndex] && create) {
			this.subtrees[subtreeIndex] = this.createSubtree(
				(p.x < this.c.x ? this.c.x - this.halfDim : this.c.x + this.halfDim),
				(p.y < this.c.y ? this.c.y - this.halfDim : this.c.y + this.halfDim),
				(p.z < this.c.z ? this.c.z - this.halfDim : this.c.z + this.halfDim)
			);
		}
		return this.subtrees[subtreeIndex];
	}

	this.createSubtree = function(x, y, z) {
		var center = new THREE.Vector3(
			(this.c.x + x) / 2,
			(this.c.y + y) / 2,
			(this.c.z + z) / 2
		);
		return new Octree(center, this.halfDim / 2, this.minDim);
	}

	this.getMinimalHalfDim = function() {
		var hd = this.halfDim;
		while (hd > this.minDim) {
			hd /= 2;
		}
		return hd;
	}
}

window.addEventListener('load', init);

function init() {
	if (!Detector.webgl)
		Detector.addGetWebGLMessage();

	camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );

	controls = new THREE.OrbitControls(camera);
	controls.addEventListener('change', render);
	// some custom control settings
	controls.enablePan = false;
	controls.minDistance = 2;
	controls.maxDistance = 10;
	controls.zoomSpeed = 2.0;
	controls.target = new THREE.Vector3(0, 2, 0);

	camera.position.x = 5;

	// world
	scene = new THREE.Scene();

	// lights
	var light = new THREE.DirectionalLight( 0xffffff );
	light.position.set( 10, 5, 15 );
	scene.add( light );

	light = new THREE.DirectionalLight( 0x444444 );
	light.position.set( -10, -5, -15 );
	scene.add( light );

	light = new THREE.AmbientLight( 0x444444 );
	scene.add( light );

	// renderer
	renderer = new THREE.WebGLRenderer( {antialias: true } );
	renderer.setSize( window.innerWidth, window.innerHeight );

	container = document.getElementById('container');
	container.appendChild(renderer.domElement);

	stats = new Stats();
	stats.domElement.style.position = 'absolute';
	stats.domElement.style.top = '0px';
	stats.domElement.style.zIndex = 100;
	container.appendChild( stats.domElement );

	window.addEventListener( 'resize', onWindowResize, false );

	gui = new dat.GUI();
	// create the main parameters, arms will be created later
	var robotFolder = gui.addFolder('Robot');
	robotFolder.add(params, 'armCount', 1, 6).name('arm count').step(1);
	robotFolder.add(params, 'robotScale', 0.5, 4).name('scale').onChange(changeRobotScale);
	robotFolder.addColor(params, 'robotColor').name('color').onChange(changeRobotColor);

	var coverageFolder = gui.addFolder('Coverage');
	coverageFolder.add(params, 'coverage');
	coverageFolder.add(params, 'coverageType', ['particles', 'spheres', 'cubes']).name('type').onChange(onCoverageType);
	coverageFolder.add(params, 'coverageTransparent').name('transparent').onChange(changeTransparency);
	coverageFolder.add(params, 'coverageDiscrete').name('discrete').onChange(onChangeCoverageDiscrete);
	coverageFolder.add(params, 'coveragePrecision', 1, maxPrecision).step(1).name('precision').onFinishChange(onCoveragePrecision);
	coverageFolder.add(params, 'basePrecision', 0, maxBasePrecision).step(1).onFinishChange(onCoveragePrecision);
	coverageFolder.add(params, 'coverageScale', 0.1, 1).name('scale').onChange(changeCoverageScale);
	coverageFolder.addColor(params, 'coverageColor').name('color').onChange(changeCoverageColor);

	updateScene();

	onWindowResize();

	animate();
}

function createArms(armCount) {
	var baseRotation = 0;
	var baseConstraint = null;
	var armParams = [];
	if (null != baseArm) {
		arms.forEach(function(arm) {
			armParams.push({
				armLen: arm.armLen,
				rotation: arm.rotation.x,
				constraint: arm.constraint
			});
			delete arm;
		});
		baseRotation = baseArm.rotation.y;
		baseConstraint = baseArm.constraint;
		delete baseArm;
	}
	arms = [];
	baseArm = new RobotArm(0.2);
	baseArm.rotation.y = baseRotation;
	if (baseConstraint) {
		baseArm.constraint = baseConstraint;
	}
	var prevArm = baseArm;
	for (var i = 0; i < armCount; ++i) {
		arms[i] = new RobotArm(1);
		prevArm.addArm(arms[i]);
		prevArm = arms[i];
	}
	var minSize = Math.min(armParams.length, armCount);
	for (var i = 0; i < minSize; ++i) {
		arms[i].armLen = armParams[i].armLen;
		arms[i].rotation.x = armParams[i].rotation;
		arms[i].constraint = armParams[i].constraint;
	}
	updateArmLengths();
	// also set the dirty sphere count
	coverageDirtyCount = true;
}

function updateArmLengths() {
	arms.forEach(function(arm) {
		arm.updateArmLength();
	});
	coverageDirtyPos = true;
}

function updateArmConstraints() {
	if (baseArm) {
		baseArm.updateConstraints(true);
		var controller = armGuiFolders[0].__controllers[0];
		controller.min(baseArm.constraint.min);
		controller.max(baseArm.constraint.max);
		controller.updateDisplay();
	}
	arms.forEach(function(arm) {
		arm.updateConstraints(false);
	});
	for (var i = 1; i < armGuiFolders.length; ++i) {
		var controller = armGuiFolders[i].__controllers[0];
		controller.min(arms[i-1].constraint.min);
		controller.max(arms[i-1].constraint.max);
		controller.updateDisplay();
	}
	coverageDirtyPos = true;
}

function onCoveragePrecision() {
	coverageDirtyCount = true;
	coverageDirtyPos = true;
}

function onCoverageType() {
	coverageDirtyCount = true;
}

function createCoveragePositions() {
	var baseArmClone = baseArm.cloneArm();
	var lastArm = baseArmClone.getLastChild();
	// make an array with all arms to actaully go through all
	var armArray = [];
	var desc = baseArmClone.childArm;
	while(desc) {
		armArray.push({
			arm: desc,
			dRot: (desc.constraint.max - desc.constraint.min) / params.coveragePrecision
		});
		desc = desc.childArm;
	}
	// add a dummy arm so we can use it's position
	lastArm.addArm(new RobotArm(1, false));
	var endArm = lastArm.childArm;
	// set the base arm rotation
	if (params.basePrecision != 0) {
		baseArmClone.rotation.y = baseArmClone.constraint.min;
	} else {
		baseArmClone.rotation.y = 0;
	}
	baseArmClone.updateMatrixWorld();
	// set all arm positions to minimum
	var resetDescending = function(arm) {
		arm.traverse(function(a) {
			a.rotation.x = a.constraint.min;
		});
	};
	resetDescending(baseArmClone.childArm);
	baseArmClone.updateMatrixWorld();
	const armCount = armArray.length;
	armStack = [];
	for (var i = 0; i < armCount; ++i) {
		armStack.push({
			index: i,
			iteration: 0
		});
	}
	coveragePositions = [];
	const lastArmDRot = armArray[armCount - 1].dRot;
	const lastArmMin = armArray[armCount - 1].arm.constraint.min;
	while(armStack.length > 0) {
		var armTop = armStack.pop();
		var armRef = armArray[armTop.index].arm;
		// if this is the last arm, iterate it and take all positions
		if (armTop.index == armCount - 1) {
			for (var i = 0; i < params.coveragePrecision + 1; ++i) {
				armRef.rotation.x = lastArmMin + lastArmDRot * i;
				// the parenting matrices should be updated, so update just this one
				armRef.updateMatrixWorld();
				var endPoint = new THREE.Vector3();
				endPoint.setFromMatrixPosition(endArm.matrixWorld);
				coveragePositions.push(endPoint);
			}
		} else if (armTop.iteration < params.coveragePrecision) {
			armTop.iteration++;
			armRef.rotation.x = armRef.constraint.min + armArray[armTop.index].dRot * armTop.iteration;
			// reset descending arms
			resetDescending(armRef.childArm);
			// update matrices
			armRef.updateMatrixWorld();
			// now push again elements on the stack along with this arm
			armStack.push(armTop);
			for (var i = armTop.index + 1; i < armCount; ++i) {
				armStack.push({
					index: i,
					iteration: 0
				});
			}
		} // else just continue with the next object on the stack
	}

	// delete the base arm clone
	delete baseArmClone;

	// if the base precision is > 0, the coverage must be rotated around y
	if (params.basePrecision != 0) {
		const deltaRot = (baseArmClone.constraint.max - baseArmClone.constraint.min) / params.basePrecision;
		const axis = new THREE.Vector3(0, 1, 0);
		const baseCoverageCount = coveragePositions.length;
		for (var i = 1; i <= params.basePrecision; ++i) {
			for (var j = 0; j < baseCoverageCount; ++j) {
				var vec = new THREE.Vector3(
					coveragePositions[j].x,
					coveragePositions[j].y,
					coveragePositions[j].z
				);
				vec.applyAxisAngle(axis, deltaRot * i);
				coveragePositions.push(vec);
			}
		}
	}

	if (params.coverageDiscrete) {
		var combinedArmLen = baseArm.getCombinedArmLength();
		var octree = new Octree(new THREE.Vector3(-0.1, 0, 0), combinedArmLen + 0.5, coverageParticleSize * params.coverageScale);
		coveragePositions.forEach(function(pos) {
			octree.addPoint(pos);
		});
		var newPositions = [];
		octree.getCentersWithPoint(newPositions);
		var minDim = octree.getMinimalHalfDim() * 2;
		var updateCount = Math.abs(currentParams.minDim - minDim) > epsilon || spheres.length != newPositions.length;
		if (updateCount) {
			currentParams.minDim = minDim;
		}
		coverageDirtyCount = coverageDirtyCount || updateCount;
		coveragePositions = newPositions;
	}
}

function addSpheres() {
	spheres.forEach(function(sphere) {
		scene.remove(sphere);
		delete sphere;
	});
	spheres = [];
	if (particles) {
		scene.remove(particles);
		delete particles;
		particles = null;
	}
	if (params.coverageType == 'particles') {
		var geometry = new THREE.BufferGeometry();
		const posCount = coveragePositions.length;
		var positions = new Float32Array(posCount * 3);
		for (var i = 0; i < posCount; ++i) {
			positions[i * 3    ] = coveragePositions[i].x;
			positions[i * 3 + 1] = coveragePositions[i].y;
			positions[i * 3 + 2] = coveragePositions[i].z;
		}
		geometry.addAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geometry.computeBoundingSphere();
		var material = new THREE.PointsMaterial({
			size: coverageParticleSize * params.coverageScale
		});
		if (params.coverageDiscrete) {
			material.size = currentParams.minDim * 1.3333;
		}
		material.color = new THREE.Color(parseInt(params.coverageColor.replace('#', '0x')));
		if (params.coverageTransparent) {
			material.transparent = true;
			material.opacity = 0.2;
		}
		particles = new THREE.Points(geometry, material);
		scene.add(particles);
	} else {
		var geom = null;
		var geomSize = (params.coverageDiscrete ? currentParams.minDim : coverageParticleSize);
		if (params.coverageType == 'spheres') {
			geom = new THREE.SphereGeometry(geomSize / 2, 8, 6);
		} else if (params.coverageType == 'cubes') {
			geom = new THREE.CubeGeometry(geomSize, geomSize, geomSize);
		}
		var sphereMat = new THREE.MeshLambertMaterial();
		sphereMat.color = new THREE.Color(parseInt(params.coverageColor.replace('#', '0x')));
		if (params.coverageTransparent) {
			sphereMat.transparent = true;
			sphereMat.opacity = 0.2;
		}
		var sphMesh = new THREE.Mesh(geom, sphereMat);
		if (!params.coverageDiscrete) {
			sphMesh.scale.x = params.coverageScale;
			sphMesh.scale.y = params.coverageScale;
			sphMesh.scale.z = params.coverageScale;
		}
		coveragePositions.forEach(function(pos) {
			var sp = sphMesh.clone();
			sp.position.setX(pos.x);
			sp.position.setY(pos.y);
			sp.position.setZ(pos.z);
			spheres.push(sp);
		});
		spheres.forEach(function(sphere) {
			scene.add(sphere);
		});
	}
}

function changeTransparency() {
	if (particles) {
		particles.material.transparent = params.coverageTransparent;
		particles.material.opacity = 0.2;
	} else {
		spheres.forEach(function(mesh) {
			mesh.material.transparent = params.coverageTransparent;
			mesh.material.opacity = 0.2;
		});
	}
}

function onChangeCoverageDiscrete() {
	coverageDirtyPos = true;
	coverageDirtyCount = true;
}

function changeCoverageColor() {
	var colorObj = new THREE.Color(parseInt(params.coverageColor.replace('#', '0x')));
	if (particles) {
		particles.material.color = colorObj;
	} else {
		spheres.forEach(function(mesh) {
			mesh.material.color = colorObj;
		});
	}
}

function changeCoverageScale() {
	if (params.coverageDiscrete) {
		coverageDirtyPos = true;
		// the dirty count will be updated in the octree calculation if
	} else {
		if (particles) {
			particles.material.size = coverageParticleSize * params.coverageScale;
		} else {
			spheres.forEach(function(mesh) {
				mesh.scale.x = params.coverageScale;
				mesh.scale.y = params.coverageScale;
				mesh.scale.z = params.coverageScale;
			});
		}
		currentParams.minDim = 0;
	}
}

function updateScene() {
	var armsUpdated = false;
	if (currentParams.armCount != params.armCount) {
		if (null != baseArm) {
			scene.remove(baseArm);
		}
		createArms(params.armCount);
		scene.add(baseArm); // created by createArms(..)
		currentParams.armCount = params.armCount;
		armsUpdated = true;
	}
	if (armsUpdated) {
		updateDatGui();
	}
	if (coverageDirtyPos || coverageDirtyCount) {
		if (coverageDirtyPos) {
			createCoveragePositions();
			coverageDirtyPos = false;
		}
		if (coverageDirtyCount) {
			addSpheres();
			coverageDirtyCount = false;
			currentParams.coverageType = params.coverageType;
		} else {
			// only update the sphere positions
			const covLen = coveragePositions.length;
			if (currentParams.coverageType == 'particles') {
				const posCount = coveragePositions.length;
				var positions = new Float32Array(posCount * 3);
				for (var i = 0; i < posCount; ++i) {
					positions[i * 3    ] = coveragePositions[i].x;
					positions[i * 3 + 1] = coveragePositions[i].y;
					positions[i * 3 + 2] = coveragePositions[i].z;
				}
				particles.geometry.removeAttribute('position');
				particles.geometry.addAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
			} else {
				for (var i = 0; i < covLen; ++i) {
					spheres[i].position.setX(coveragePositions[i].x);
					spheres[i].position.setY(coveragePositions[i].y);
					spheres[i].position.setZ(coveragePositions[i].z);
				}
			}
		}
	}
	if (coverageDirtyTransparency) {
		changeTransparency();
	}
}

// GUI

function updateDatGui() {
	gui.close();
	armGuiFolders.forEach(function(folder) {
		gui.removeFolder(folder);
	});

	armGuiFolders = [];
	// first add the folder for the baseArm
	var folder = gui.addFolder("Base");
	folder.add(baseArm.rotation, 'y', baseArm.constraint.min, baseArm.constraint.max).name('rotation');
	folder.add(baseArm.constraint, 'min', -Math.PI, 0).onChange(function() {
		updateArmConstraints();
	});
	folder.add(baseArm.constraint, 'max', 0, Math.PI).onChange(function() {
		updateArmConstraints();
	});
	armGuiFolders.push(folder);

	for ( var i = 0; i < arms.length; i ++ ) {
		var arm = arms[i];
		folder = gui.addFolder('Arm ' + i);
		folder.add(arm.rotation, 'x', arm.constraint.min, arm.constraint.max).name('rotation');
		folder.add(arm.constraint, 'min', -Math.PI, 0).onChange(function() {
			updateArmConstraints();
		});
		folder.add(arm.constraint, 'max', 0, Math.PI).onChange(function() {
			updateArmConstraints();
		});
		folder.add(arm, 'armLen', 0.5, 4).onChange(function(value) {
			updateArmLengths();
		});
		armGuiFolders.push(folder);
	}
	gui.open();
}

// Render

function animate() {
	render();
	requestAnimationFrame(animate);
	controls.update();
}

function onWindowResize() {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
	render();
}

function render() {
	//addArms();
	var dTime = Date.now() - startTime;
	spheres.forEach(function (s) {
		s.visible = params.coverage;
		//s.position.x = Math.sin(dTime / 300);
	});
	if (particles) {
		particles.visible = params.coverage;
	}
	updateScene();
	renderer.render( scene, camera );
	stats.update();
}
