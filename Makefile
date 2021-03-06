# This file is part of DAV-4-TbSync.
#
# TbSync is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# TbSync is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with DAV-4-TbSync. If not, see <https://www.gnu.org/licenses/>.

.PHONY: build

build:
	# Sync all files except git technical files
	# and screenshots
	zip ../DAV-4-TbSync.xpi -FS -R '*' \
		-x 'screenshots' '.git/*' '.gitignore'

